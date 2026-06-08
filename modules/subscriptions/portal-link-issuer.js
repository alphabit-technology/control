'use strict';

import { loopar } from 'loopar';
import crypto from 'node:crypto';

/**
 * Portal Link issuer — short, unguessable tokens that wrap the activation /
 * billing-portal flow with a stable, Loopar-hosted URL.
 *
 * Why this exists:
 *   Stripe billing portal session URLs expire in roughly an hour and are
 *   tied to a single browser session. That's a problem for activation
 *   emails: if the customer opens the email next morning, the button is
 *   already dead. So instead of embedding the raw Stripe URL, we embed a
 *   Loopar deep link with a token. The token lives until the end of the
 *   billing period; each click generates a *fresh* Stripe portal session.
 *
 * Token semantics:
 *   - Multi-use within the validity window: customer can bookmark the email
 *     and come back to it during the cycle.
 *   - Revocable: when the operator resends the activation email, the old
 *     token is marked `revoked_at = NOW` so a leaked email can't be cashed.
 *   - Audited: first click stamps `used_at` for visibility, but does NOT
 *     block further clicks.
 *
 * The token itself is just random hex — no signed JWT — because the only
 * thing it grants is a redirect to a Stripe portal session whose customer
 * lookup is already gated by the row's subscription/customer linkage. No
 * server-to-server handshake needed.
 */

const TOKEN_BYTES = 24;  // 48-char hex token in the URL

/**
 * Issue a new Portal Link for the given Subscription. Revokes any active
 * Portal Link previously issued for the same Subscription before creating
 * the new one — so only the latest email's button works.
 *
 * @param {string} subscriptionName  Loopar Subscription `name`
 * @param {Date|string|number} expiresAt
 *        Absolute expiry — typically the Stripe `current_period_end`.
 *        Can be a Date, ISO string, or seconds-since-epoch.
 * @returns {Promise<{ token: string, expires_at: string }>}
 */
export async function issuePortalLink(subscriptionName, expiresAt) {
  if (!subscriptionName) {
    throw new Error('issuePortalLink: missing subscriptionName');
  }
  if (expiresAt == null) {
    throw new Error('issuePortalLink: missing expiresAt');
  }

  const expiresIso = toIso(expiresAt);
  await revokeActiveLinksFor(subscriptionName);

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const link = await loopar.newDocument('Portal Link');
  link.name         = token;
  link.subscription = subscriptionName;
  link.expires_at   = expiresIso;
  // Framework footgun: Loopar's date_time stringifier defaults undefined
  // values to NOW() instead of NULL (see packages/loopar/core/global/
  // date-utils.js:18 — `date = new Date()` as the param default). That makes
  // the link look "revoked-on-arrival" to inspectPortalLink. Explicit nulls
  // sidestep the default.
  link.used_at      = null;
  link.revoked_at   = null;
  link.status       = 'active';
  await link.save();

  return { token, expires_at: expiresIso };
}

/**
 * Mark all currently-active Portal Links for a Subscription as `revoked`,
 * so the old email button stops working when the operator issues a new one.
 */
export async function revokeActiveLinksFor(subscriptionName) {
  // We rely on in-memory filtering because the structured filter has had
  // edge cases when combining IS NULL with another predicate. The volume
  // here is tiny (a handful of links per sub max).
  const all = await loopar.db.getAll(
    'Portal Link',
    ['name', 'subscription', 'status']
  );
  const now = new Date().toISOString();
  for (const row of all || []) {
    if (row.subscription !== subscriptionName) continue;
    // Status is the truth (see inspectPortalLink for why we don't trust
    // revoked_at on its own). Skip anything already revoked.
    if (row.status === 'revoked')              continue;
    try {
      await loopar.db.updateRow('Portal Link', row.name, {
        revoked_at: now,
        status:     'revoked',
      });
    } catch (err) {
      console.warn(`[portal-link] could not revoke ${row.name}:`, err.message);
    }
  }
}

/**
 * Look up a Portal Link and tell the caller whether it can be used right
 * now. Doesn't mutate anything — the caller decides whether to consume.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: 'not_found'|'revoked'|'expired',
 *   link?: object   // the raw row when ok
 * }>}
 */
export async function inspectPortalLink(token) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'not_found' };
  }
  const link = await loopar.getDocument(
    'Portal Link', token, null, { ifNotFound: null }
  );
  if (!link?.name) return { ok: false, reason: 'not_found' };

  // Source of truth is `status`. `revoked_at` is denormalized audit info
  // and unreliable on its own — Loopar's date_time stringifier defaults
  // missing values to NOW (see comment in issuePortalLink), so even a
  // freshly created link can carry a phantom timestamp here.
  if (link.status === 'revoked') return { ok: false, reason: 'revoked' };

  const exp = link.expires_at ? new Date(link.expires_at).getTime() : 0;
  if (!exp || exp < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, link };
}

/**
 * Stamp `used_at` on first use. Idempotent: re-clicks within the validity
 * window don't overwrite the original audit timestamp.
 */
export async function markUsedIfFirstTime(token) {
  try {
    const link = await loopar.getDocument(
      'Portal Link', token, null, { ifNotFound: null }
    );
    if (!link?.name) return;
    // Same reason we don't trust `revoked_at` in inspect: phantom NOW
    // defaults from the framework would make every fresh link look already
    // used. Status is the reliable signal.
    if (link.status === 'used') return;
    await loopar.db.updateRow('Portal Link', link.name, {
      used_at: new Date().toISOString(),
      status:  'used',
    });
  } catch (err) {
    // Non-fatal — audit only.
    console.warn(`[portal-link] could not stamp used_at for ${token}:`, err.message);
  }
}

/**
 * Build the public URL of a Portal Link from a token.
 *
 *   https://<control-plane>/api/Signup/openPortal?token=<token>
 *
 * Base URL is resolved in this order:
 *   1. Explicit `baseUrl` argument — typically derived from the current
 *      request headers (proto + host) by the calling action. This is the
 *      zero-config path: whatever host the operator is using to drive
 *      the control plane is the same host that goes into the email.
 *   2. `CONTROL_PLANE_URL` env var — explicit override for background
 *      jobs / webhook handlers that have no request context.
 *   3. Dev fallback `http://control.localhost:<PORT>` — only useful for
 *      local development; an operator who sees this in a real email
 *      knows immediately something is misconfigured.
 */
export function buildPortalLinkUrl(token, baseUrl) {
  let base = String(baseUrl || process.env.CONTROL_PLANE_URL || '').trim();
  if (!base) {
    const port = process.env.PORT || '3000';
    base = `http://control.localhost:${port}`;
  }
  base = base.replace(/\/+$/, '');
  return `${base}/api/Signup/openPortal?token=${encodeURIComponent(token)}`;
}

/**
 * Pull the control-plane base URL from a live request. Mirrors the
 * `${proto}://${host}` pattern used elsewhere in signup-controller for
 * Stripe success/cancel URLs — keeps the link in the email pointing at
 * the same host the operator is hitting.
 *
 * Prefers X-Forwarded-* over Host / req.protocol because Caddy explicitly
 * sets both X-Forwarded-Proto (scheme placeholder) and X-Forwarded-Host
 * (the public domain) when reverse-proxying to the app, while the raw
 * Host header could be rewritten by a future config change.
 *
 * Returns null if the request is missing (e.g. webhook context); the
 * caller should then rely on the env-var fallback.
 */
export function controlPlaneBaseUrlFromReq(req) {
  if (!req) return null;
  const proto = req.headers?.['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers?.['x-forwarded-host'] || req.headers?.host;
  if (!host) return null;
  return `${proto}://${host}`;
}

function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') {
    // Heuristic: Stripe uses seconds; anything below year 3000 in seconds
    // (≈3.2e10) and we treat as seconds, otherwise milliseconds.
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  if (typeof v === 'string') return new Date(v).toISOString();
  throw new Error(`portal-link-issuer: cannot normalize expiresAt: ${v}`);
}
