'use strict';

import { loopar, tenant, Op } from 'loopar';
import fs from 'fs';
import path from 'pathe';
import crypto from 'node:crypto';
import { issueClaimToken } from './claim-issuer.js';

/**
 * Provisioning is fire-and-forget from the Stripe webhook, so a crash of the
 * control-plane process between checkout.session.completed and a clean
 * `tenant_provisioned=1` would leave the Subscription stuck. To make the
 * pipeline self-healing we persist `provisioning_attempts` / `retry_after` /
 * `last_error` on the Subscription and a cron + boot hook walk the candidates.
 *
 * Backoff sequence (ms after attempt N fails): 1m, 5m, 15m, 1h, 6h. After
 * MAX_PROVISIONING_ATTEMPTS failures the Subscription is marked `failed` and
 * stays out of the retry pool — the operator has to investigate and clear
 * `provisioning_attempts` manually to try again.
 */
export const MAX_PROVISIONING_ATTEMPTS = 5;
const PROVISIONING_BACKOFF_MS = [
  60 * 1000,            // 1m
  5  * 60 * 1000,       // 5m
  15 * 60 * 1000,       // 15m
  60 * 60 * 1000,       // 1h
  6  * 60 * 60 * 1000,  // 6h
];

function nextRetryAfter(attemptsSoFar) {
  // attemptsSoFar is the count AFTER incrementing for the failure we just had.
  // We index BACKOFF[attemptsSoFar - 1] so attempt 1 -> 1m, attempt 5 -> 6h.
  const idx = Math.max(0, Math.min(PROVISIONING_BACKOFF_MS.length - 1, attemptsSoFar - 1));
  return new Date(Date.now() + PROVISIONING_BACKOFF_MS[idx]).toISOString();
}

/**
 * Sweep Subscriptions whose `provisioning_retry_after` is overdue and
 * re-run `provisionTenant` on each. Runs IN SERIES (PM2 / Caddy / install
 * are too heavyweight to fan out concurrently). Exposed both as
 * `/api/Signup/retryProvisioning` (cron) and as a boot-time call from the
 * framework's builder.js so a crashed mid-flight provisioning recovers
 * within a minute of the control plane coming back up.
 *
 * Idempotent: provisionTenant short-circuits on already-provisioned subs
 * and refuses retries past the cap, so calling this more often than
 * necessary is harmless.
 *
 * @returns {Promise<{attempted:number, succeeded:number, failed:number, skipped:number}>}
 */
export async function runProvisioningRetrySweep() {
  const out = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };

  let rows;
  try {
    rows = await loopar.db.getAll(
      'Subscription',
      ['name', 'tenant_name', 'status', 'tenant_provisioned',
       'provisioning_attempts', 'provisioning_retry_after'],
      {
        tenant_provisioned: 0,
        // Only retry subs Stripe still considers live. Canceled / past_due
        // would be picked up by their own lifecycle handlers.
        status: { [Op.in]: ['active', 'trialing'] },
        // Overdue: retry_after is set AND <= now.
        provisioning_retry_after: { [Op.lte]: new Date().toISOString() },
      }
    );
  } catch (err) {
    console.error('[provisioning/retry] could not list candidates:', err.message);
    return out;
  }

  for (const row of rows || []) {
    if (!row.name || !row.tenant_name) {
      out.skipped++;
      continue;
    }
    const attempts = Number(row.provisioning_attempts) || 0;
    if (attempts >= MAX_PROVISIONING_ATTEMPTS) {
      out.skipped++;
      continue;
    }
    out.attempted++;
    try {
      const ok = await provisionTenant(row.name);
      if (ok) out.succeeded++; else out.failed++;
    } catch (err) {
      // provisionTenant already persists its own error state — this catch
      // is just so one bad row doesn't abort the whole sweep.
      console.error(`[provisioning/retry] ${row.name} threw:`, err.message);
      out.failed++;
    }
  }

  if (out.attempted > 0) {
    console.log(
      `[provisioning/retry] swept ${out.attempted} ` +
      `(${out.succeeded} ok, ${out.failed} fail, ${out.skipped} skipped)`
    );
  }
  return out;
}

// Domain suffix for new cloud workspaces. Defaults to `.localhost` for dev;
// production sets this in the control tenant's .env once wildcard DNS is wired.
function getDomainSuffix() {
  const raw = String(process.env.CLOUD_DOMAIN_SUFFIX || '.localhost').trim();
  return raw.startsWith('.') ? raw : '.' + raw;
}

function getVerifierUrl() {
  if (process.env.CLOUD_VERIFIER_PUBLIC_URL) {
    return String(process.env.CLOUD_VERIFIER_PUBLIC_URL);
  }
  const suffix = getDomainSuffix();
  const protocol = suffix === '.localhost' ? 'http' : 'https';
  const controlTenant = loopar.tenantId || 'cloud';

  if (suffix === '.localhost') {
    const controlPort =
      process.env.PORT ||
      tenant.readEnvFile(controlTenant)?.PORT;
    if (controlPort) {
      return `${protocol}://${controlTenant}.localhost:${controlPort}/api/auth-claim/verify`;
    }
  }
  return `${protocol}://${controlTenant}${suffix}/api/auth-claim/verify`;
}

/**
 * First-login magic-link email. Uses `loopar.mail.send` (sync) so a
 * delivery failure surfaces immediately and the Subscription can be marked
 * with an error step. Could be moved to `loopar.mail.queue` with an
 * `Email Template` once we want the same copy editable from the desk.
 */
async function sendClaimEmail({ to, claimUrl, tenantName, planName, expiresAt }) {
  const expiresStr = new Date(expiresAt).toUTCString();
  const subject = `Your Loopar workspace is ready — sign in to ${tenantName}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
      <h2 style="margin: 0 0 16px 0;">Your workspace is live</h2>
      <p>Thanks for subscribing to <strong>${planName || 'Loopar Cloud'}</strong>.</p>
      <p>Click the button below to open your workspace — you'll be signed in automatically. The link is one-use and expires on <strong>${expiresStr}</strong>.</p>
      <p style="margin: 28px 0;">
        <a href="${claimUrl}"
           style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Open ${tenantName}
        </a>
      </p>
      <p style="color:#666;font-size:13px">
        If the button doesn't work, copy this link into your browser:<br>
        <span style="word-break: break-all">${claimUrl}</span>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="color:#999;font-size:12px">
        Once you're in, set your own password from the desk banner or from Profile → Reset by email.
      </p>
    </div>
  `;
  return loopar.mail.send({ to, subject, html });
}

function emitProgress(subscriptionId, step, payload = {}) {
  // Public progress channel — uses the default `__global__` room so the
  // post-checkout success page (unauthenticated) can subscribe to it.
  // Clients filter by `subscription_id`.
  try {
    loopar.emit('provisioning-progress', {
      subscription_id: subscriptionId,
      step,
      timestamp: Date.now(),
      ...payload,
    });
  } catch (err) {
    // emit() is best-effort; never let a missing realtime channel break
    // provisioning.
    console.warn('[provisioning] emit failed:', err.message);
  }
}

async function setSubscriptionStep(subscription, step) {
  try {
    subscription.provisioning_step = step;
    await subscription.save({ validate: false });
  } catch (err) {
    console.warn('[provisioning] could not persist step', step, '-', err.message);
  }
}

/**
 * Provision the tenant for a cloud Subscription. Idempotent: short-circuits
 * if the Subscription is already marked `tenant_provisioned`.
 *
 * @param {string} subscriptionName  Loopar `name` of the Subscription record.
 */
export async function provisionTenant(subscriptionName) {
  if (!subscriptionName) {
    console.warn('[provisioning] missing subscription name — skipping');
    return false;
  }

  const subscription = await loopar.getDocument('Subscription', subscriptionName);
  if (!subscription?.name) {
    console.warn(`[provisioning] Subscription "${subscriptionName}" not found`);
    return false;
  }

  if (subscription.tenant_provisioned === 1 || subscription.tenant_provisioned === '1') {
    console.log(`[provisioning] ${subscriptionName} already provisioned — skipping`);
    return true;
  }

  // Honor the "given up" mark from previous retries. The operator clears
  // `provisioning_attempts` (and `provisioning_step` if they want a clean
  // log) to re-enable retries — we treat anything at or above the cap as
  // permanently failed so a manual reset is explicit.
  const priorAttempts = Number(subscription.provisioning_attempts) || 0;
  if (priorAttempts >= MAX_PROVISIONING_ATTEMPTS) {
    console.warn(
      `[provisioning] ${subscriptionName} reached ${priorAttempts} attempts — refusing further retries until cleared`
    );
    return false;
  }

  const tenantName = String(subscription.tenant_name || '').trim();
  if (!tenantName) {
    const msg = 'Subscription has no tenant_name — not a cloud purchase';
    console.warn('[provisioning]', msg);
    emitProgress(subscriptionName, 'error', { message: msg });
    return false;
  }

  // Resolve customer — needed both for the first-Administrator email seed
  // and for the magic-link recipient. Without a Customer record we can still
  // boot the tenant but can't send the welcome email.
  let customer = null;
  let customerEmail = '';
  try {
    if (subscription.customer) {
      customer = await loopar.getDocument('Customer', subscription.customer);
      customerEmail = customer?.email || '';
    }
  } catch (err) {
    console.warn('[provisioning] could not resolve Customer:', err.message);
  }

  const domainSuffix = getDomainSuffix();
  const domain = `${tenantName}${domainSuffix}`;

  try {
    // ---- 1) allocate port -------------------------------------------------
    emitProgress(subscriptionName, 'allocating', { tenant_name: tenantName });
    await setSubscriptionStep(subscription, 'allocating');

    // Refuse if the sites/<name>/ directory already exists with a real .env —
    // means another process won the race or the tenant was hand-created.
    const sitesDir = path.join(process.cwd(), 'sites', tenantName);
    if (fs.existsSync(path.join(sitesDir, '.env'))) {
      throw new Error(`Tenant directory "${tenantName}" already exists`);
    }

    const port = tenant.allocateFreePort();
    subscription.port = port;
    await subscription.save({ validate: false });

    // ---- 2) issue magic-link claim token --------------------------------
    // We need the verifier_token BEFORE writing the .env so the new tenant
    // can authenticate its callback to the control plane right after boot.
    // The JWT itself is stashed for use after PM2 is up (we send it via
    // email at the very end so the customer doesn't click before the tenant
    // is reachable).
    let claim = null;
    if (customer?.email) {
      try {
        claim = await issueClaimToken(subscription, customer);
      } catch (err) {
        // A claim-token failure is non-fatal: the tenant still gets
        // provisioned; the customer recovers via the standard "forgot
        // password" flow once they reach the login page.
        console.warn('[provisioning] could not issue claim token:', err.message);
      }
    } else {
      console.warn(`[provisioning] no Customer email for ${subscriptionName} — skipping magic-link`);
    }

    // ---- 2b) register Provisioned Tenant (canonical per-tenant secret) ---
    // This row is the control plane's record of trust for this tenant. The
    // `verifier_token` (same value written to the tenant's CLOUD_VERIFIER_TOKEN
    // env) authenticates every server-to-server call FROM the tenant TO the
    // control plane (claim verify today, cloud-mail gateway, future flows).
    if (claim?.verifier_token) {
      try {
        let pt = await loopar.getDocument('Provisioned Tenant', tenantName, null, { ifNotFound: null });
        if (pt?.name) {
          await loopar.db.updateRow('Provisioned Tenant', tenantName, {
            verifier_token: claim.verifier_token,
            customer_email: customerEmail,
          });
        } else {
          pt = await loopar.newDocument('Provisioned Tenant');
          pt.name           = tenantName;
          pt.verifier_token = claim.verifier_token;
          pt.customer_email = customerEmail;
          await pt.save({ validate: false });
        }
      } catch (err) {
        // Non-fatal: claim verify falls back to the Claim Token row, but the
        // cloud-mail gateway needs this — log loudly.
        console.error('[provisioning] could not register Provisioned Tenant:', err.message);
      }
    }

    // ---- 3..6) tenant bring-up — delegate to TenantManager.provision -----
    // Single call writes the .env (with our custom CUSTOMER_EMAIL / CLOUD_*
    // keys merged in), seeds db.config.json from the control plane, brings
    // Caddy + PM2 online, waits for HTTP, and runs `/api/System/install`.
    // Progress events are forwarded through emitProgress / setSubscriptionStep
    // so the success page sees each step over realtime.
    const tenantDoc = await loopar.newDocument('Tenant Manager', {
      id:       tenantName,
      port,
      domain,
      node_env: process.env.NODE_ENV || 'development',
    });
    tenantDoc.name = tenantName;

    // INSTALL_TOKEN: random per-tenant secret that the new tenant's installer
    // endpoint validates against `X-Install-Token`. With it the install POST
    // is no longer "anyone-who-reaches-the-port-first wins" — only this
    // provisioning run (which holds the secret) can install loopar. After
    // success we wipe the token from the .env (defense in depth; the
    // installer also refuses re-installs once loopar.__installed__ flips).
    const installToken = crypto.randomBytes(32).toString('hex');

    await tenantDoc.provision({
      env: {
        CUSTOMER_EMAIL:       customerEmail,
        CLOUD_VERIFIER_URL:   claim ? getVerifierUrl()     : '',
        CLOUD_VERIFIER_TOKEN: claim ? claim.verifier_token : '',
        INSTALL_TOKEN:        installToken,
      },
      // Source for the new tenant's db.config.json — we clone the control
      // plane's template (SQLite today; could become a shared Postgres later
      // by changing only the control plane's config).
      dbConfigFrom: loopar.tenantId,
      install:      true,
      installPayload: {
        email:            customerEmail || '',
        company:          tenantName,
        admin_password:   '',
        confirm_password: '',
      },
      installHeaders: {
        'X-Install-Token': installToken,
      },
      onProgress: (step, payload) => {
        emitProgress(subscriptionName, step, payload);
        // Persist the step on the Subscription too, so a slow client that
        // missed the realtime burst can still read progress via /signup/status.
        // Fire-and-forget — a save failure must not stop provisioning.
        setSubscriptionStep(subscription, step).catch(() => {});
      },
    });

    // Install succeeded — scrub INSTALL_TOKEN from the .env so a future
    // restart can't reopen the install window. The live tenant process
    // still has it in process.env until its next restart, but the system
    // controller refuses to re-install once `loopar.__installed__` is true,
    // so the token is already inert from a security standpoint.
    try {
      await tenant.saveTenant({ name: tenantName, INSTALL_TOKEN: '' });
    } catch (err) {
      console.warn(`[provisioning] could not scrub INSTALL_TOKEN: ${err.message}`);
    }

    // ---- 7) send magic-link email ----------------------------------------
    // Done AFTER pm2 is up so a fast clicker doesn't hit a tenant that isn't
    // serving yet. Email failure is non-fatal — the tenant is reachable and
    // the customer can use "forgot password" instead.
    if (claim && customer?.email) {
      emitProgress(subscriptionName, 'sending-email', { to: customer.email });
      await setSubscriptionStep(subscription, 'sending-email');
      try {
        await sendClaimEmail({
          to:         customer.email,
          claimUrl:   claim.claim_url,
          tenantName,
          planName:   subscription.plan_name,
          expiresAt:  claim.expires_at,
        });
      } catch (err) {
        console.error('[provisioning] sendClaimEmail failed:', err.message);
        emitProgress(subscriptionName, 'email-failed', { message: err.message });
        // continue — do not throw
      }
    }

    // ---- 8) mark complete -------------------------------------------------
    // On success: clear the retry trail so the cron stops considering this
    // Subscription, but keep `provisioning_attempts` as audit (so we can see
    // it took N tries). Errors are wiped to avoid stale text in the desk UI.
    subscription.tenant_provisioned      = 1;
    subscription.provisioning_step       = 'ready';
    subscription.provisioning_retry_after = null;
    subscription.provisioning_last_error  = null;
    await subscription.save({ validate: false });

    const url = tenant.tenantUrl(tenantName, { domain, port });

    emitProgress(subscriptionName, 'ready', {
      port,
      domain,
      url,
      magic_link_sent: !!(claim && customer?.email),
    });

    console.log(`[provisioning] ${tenantName} ready on ${domain} (port ${port})`);
    return true;
  } catch (err) {
    const attempts = priorAttempts + 1;
    const givenUp  = attempts >= MAX_PROVISIONING_ATTEMPTS;
    const retryAt  = givenUp ? null : nextRetryAfter(attempts);
    console.error(
      `[provisioning] failed for ${tenantName} (attempt ${attempts}/${MAX_PROVISIONING_ATTEMPTS}):`,
      err.message,
      givenUp ? '— giving up' : `— next retry at ${retryAt}`
    );
    emitProgress(subscriptionName, 'error', {
      message: err.message,
      attempts,
      retry_after: retryAt,
      given_up:    givenUp,
    });
    try {
      subscription.provisioning_step        = givenUp
        ? 'failed'
        : `error: ${err.message}`.slice(0, 240);
      subscription.provisioning_attempts    = attempts;
      subscription.provisioning_retry_after = retryAt;
      subscription.provisioning_last_error  = String(err.message || '').slice(0, 240);
      await subscription.save({ validate: false });
    } catch (_) { /* swallow — original error is already logged */ }
    return false;
  }
}
