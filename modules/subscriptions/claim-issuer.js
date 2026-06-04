'use strict';

import { loopar, tenant } from 'loopar';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

/**
 * Claim token issuer + verifier for the cloud "first login" magic-link.
 *
 * Flow:
 *   1. After `provisionTenant` succeeds, the control plane calls
 *      `issueClaimToken(subscription)` — generates a JWT signed with
 *      CLOUD_CLAIM_SECRET (control-plane-only env var), persists a
 *      `Claim Token` row keyed by the JWT's `jti`, and returns the encoded
 *      token + the `verifier_token` that the new tenant will use to
 *      authenticate its verification request.
 *   2. The customer clicks the link and lands on
 *      `https://<tenant>.../auth/claim?token=<jwt>`.
 *   3. The tenant calls back to the control plane at
 *      `POST /api/auth-claim/verify` (server→server, with the shared
 *      `CLOUD_VERIFIER_TOKEN` header). The verifier calls
 *      `verifyAndConsumeClaim(token, verifierToken, ip)` here.
 *   4. If valid, the row is marked `consumed`, the JWT is one-use only,
 *      and the verifier returns `{ valid, email, tenant }` to the tenant.
 *
 * Security properties:
 *   - The JWT signing secret never leaves the control plane.
 *   - The verifier endpoint is gated by a per-tenant shared secret so a
 *     stolen JWT alone can't be verified by anyone except the legitimate
 *     tenant process.
 *   - Tokens are single-use (status flips to `consumed`) — replay safe.
 *   - 24h expiry — the JWT verification rejects expired tokens regardless
 *     of the row's status, so even an un-cleaned `pending` row is harmless
 *     after that window.
 */

const TOKEN_TTL_SECONDS = 24 * 60 * 60;     // 24h
const VERIFIER_TOKEN_BYTES = 32;            // 64-char hex shared secret
const JTI_BYTES = 16;                       // 32-char hex jti

function getClaimSecret() {
  const s = process.env.CLOUD_CLAIM_SECRET;
  if (!s) {
    const tenantId = loopar.tenantId || 'cloud';
    throw new Error(
      '[claim-issuer] CLOUD_CLAIM_SECRET is not set in the control-plane .env. ' +
      `Generate a long random string (e.g. \`openssl rand -hex 32\`) and set it ` +
      `in sites/${tenantId}/.env before issuing claim tokens, then restart the process.`
    );
  }
  return s;
}

/**
 * Issue a one-time magic-link token for the customer that just paid.
 * Returns the encoded JWT and the shared verifier-token to inject into the
 * new tenant's .env (so it can authenticate its callback to /verify).
 *
 * @param {object} subscription Loopar `Subscription` document.
 * @param {object} customer     Loopar `Customer` document (for email).
 * @returns {Promise<{token:string, verifier_token:string, claim_url:string, expires_at:string}>}
 */
export async function issueClaimToken(subscription, customer) {
  if (!subscription?.name) throw new Error('issueClaimToken: missing subscription');
  if (!customer?.email)    throw new Error('issueClaimToken: missing customer email');
  if (!subscription.tenant_name) {
    throw new Error('issueClaimToken: subscription has no tenant_name (not a cloud purchase)');
  }

  const secret  = getClaimSecret();
  const jti     = crypto.randomBytes(JTI_BYTES).toString('hex');
  const verifierToken = crypto.randomBytes(VERIFIER_TOKEN_BYTES).toString('hex');
  const now     = Math.floor(Date.now() / 1000);
  const exp     = now + TOKEN_TTL_SECONDS;

  // Sign the JWT. We deliberately keep the payload minimal — the tenant only
  // needs the jti to look itself up against the control plane.
  const token = jwt.sign(
    {
      jti,
      tenant: subscription.tenant_name,
      email:  customer.email,
      purpose: 'initial_claim',
      iat: now,
      exp,
    },
    secret,
    { algorithm: 'HS256' }
  );

  // Persist the claim record. We use jti as the document `name` so we can
  // look it up cheaply and so duplicate jti would fail at the unique-name
  // constraint (defense-in-depth against crypto randomness corner cases).
  const claim = await loopar.newDocument('Claim Token');
  claim.name            = jti;
  claim.subscription    = subscription.name;
  claim.email           = customer.email;
  claim.tenant_name     = subscription.tenant_name;
  claim.status          = 'pending';
  claim.expires_at      = new Date(exp * 1000).toISOString();
  claim.verifier_token  = verifierToken;
  await claim.save();

  // Compose the public-facing URL the customer will click. Domain suffix is
  // controlled by CLOUD_DOMAIN_SUFFIX so dev (`.localhost`) and prod
  // (`.loopar.build`) share the same code path. We use the override form of
  // tenantUrl because at this point the tenant's .env may not exist yet (the
  // provisioning flow signs the URL before writing tenant files), so we feed
  // the domain + port directly.
  const domainSuffix = String(process.env.CLOUD_DOMAIN_SUFFIX || '.localhost').replace(/^\.?/, '.');
  const host = `${subscription.tenant_name}${domainSuffix}`;
  const baseUrl = tenant.tenantUrl(subscription.tenant_name, {
    domain: host,
    port:   subscription.port,
  });
  const claimUrl = `${baseUrl}/auth/claim?token=${encodeURIComponent(token)}`;

  return {
    token,
    verifier_token: verifierToken,
    claim_url:      claimUrl,
    expires_at:     new Date(exp * 1000).toISOString(),
  };
}

/**
 * Server-side verifier called by the tenant when a customer hits
 * `/auth/claim?token=...`. Validates the JWT, looks up the persisted row,
 * checks the shared verifier-token (so a stolen JWT alone can't be cashed),
 * marks the row consumed (one-use), and returns the identity to log in.
 *
 * @param {string} rawToken      The JWT from the URL.
 * @param {string} verifierToken The shared secret the tenant proves it knows.
 * @param {object} [ctx]         { ip, tenantHint } for audit.
 * @returns {Promise<{valid:boolean, reason?:string, email?:string, tenant?:string}>}
 */
export async function verifyAndConsumeClaim(rawToken, verifierToken, ctx = {}) {
  if (!rawToken)       return { valid: false, reason: 'missing_token' };
  if (!verifierToken)  return { valid: false, reason: 'missing_verifier' };

  let payload;
  try {
    payload = jwt.verify(rawToken, getClaimSecret(), { algorithms: ['HS256'] });
  } catch (e) {
    return {
      valid: false,
      reason: e.name === 'TokenExpiredError' ? 'expired' : 'invalid_signature',
    };
  }

  if (payload.purpose !== 'initial_claim') {
    return { valid: false, reason: 'wrong_purpose' };
  }
  if (!payload.jti) {
    return { valid: false, reason: 'no_jti' };
  }

  const claim = await loopar.getDocument('Claim Token', payload.jti);
  if (!claim?.name) {
    return { valid: false, reason: 'not_found' };
  }

  if (claim.status !== 'pending') {
    return { valid: false, reason: `already_${claim.status}` };
  }

  // Per-tenant shared secret. Canonical source is the `Provisioned Tenant`
  // row (same secret used by the Cloud Mail gateway and any future
  // server-to-server flow). Fall back to the Claim Token's own
  // verifier_token for legacy claims issued before Provisioned Tenant
  // existed. Constant-time compare to avoid timing oracles.
  const pt = await loopar.getDocument(
    'Provisioned Tenant', claim.tenant_name, null, { ifNotFound: null }
  );
  const expected = String(pt?.verifier_token || claim.verifier_token || '');
  const provided = String(verifierToken || '');
  if (!expected ||
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return { valid: false, reason: 'verifier_mismatch' };
  }

  // Defense in depth: cross-check the tenant the JWT claims with the row.
  if (claim.tenant_name !== payload.tenant) {
    return { valid: false, reason: 'tenant_mismatch' };
  }

  // Optional caller hint (the verifier endpoint passes the tenant id the
  // request came from). Reject if it doesn't match the row.
  if (ctx.tenantHint && ctx.tenantHint !== claim.tenant_name) {
    return { valid: false, reason: 'tenant_hint_mismatch' };
  }

  // Consume — one-shot. Anything that fails after this point still leaves
  // the row consumed, which is intentional: we never want a token to be
  // usable twice.
  claim.status          = 'consumed';
  claim.consumed_at     = new Date().toISOString();
  claim.claimed_from_ip = String(ctx.ip || '').slice(0, 64);
  await claim.save();

  return {
    valid:  true,
    email:  claim.email || payload.email,
    tenant: claim.tenant_name,
  };
}
