'use strict';

import { loopar, tenant } from 'loopar';
import fs from 'fs';
import path from 'pathe';
import crypto from 'node:crypto';
import { issueClaimToken } from './claim-issuer.js';

const PORT_BASE = 3100;
const PORT_MAX = 3999;

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

/**
 * Pre-seed `config/db.config.json` for the new tenant by copying the control
 * plane's template and picking a unique `database` name. With this in place
 * the new tenant skips the `/loopar/system/connect` wizard on first boot
 * and goes straight to install. SQLite for now; a future provider setting
 * could point new tenants at a shared Postgres/MySQL instead.
 */
function writeNewTenantDbConfig(tenantName) {
  const controlConfigPath = path.join(
    process.cwd(),
    'sites',
    loopar.tenantId,
    'config',
    'db.config.json'
  );
  if (!fs.existsSync(controlConfigPath)) {
    throw new Error(
      `Control plane db.config.json not found at ${controlConfigPath} — ` +
      `cannot template a new tenant's DB config.`
    );
  }

  const tmpl = JSON.parse(fs.readFileSync(controlConfigPath, 'utf8'));
  // Unique per-tenant DB name. SHA-1 of tenant+timestamp (16 hex chars) keeps
  // it short, predictable, and collision-free in practice.
  tmpl.database =
    'db_' + crypto.createHash('sha1').update(tenantName + Date.now()).digest('hex').slice(0, 16);

  const configDir = path.join(process.cwd(), 'sites', tenantName, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'db.config.json'),
    JSON.stringify(tmpl, null, 2)
  );

  return tmpl.database;
}

/**
 * Wait until the new tenant's HTTP server is accepting connections. We probe
 * with HEAD `/` — anything that returns (even a 4xx) means the server is up.
 * Polls every `delayMs` up to `maxAttempts` times.
 */
async function waitForTenantReady(domain, port, { maxAttempts = 30, delayMs = 1000 } = {}) {
  const url = `http://${domain}:${port}/`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      // Any response (even 404/302) means the server is alive and routing.
      if (r.status < 500) return true;
    } catch (_) {
      // Connection refused / DNS / etc. — keep waiting.
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Trigger the standard Loopar installer in the new tenant via its HTTP API.
 * The tenant's installer #seedFromEnv() fills missing fields (email, company,
 * password) from process.env (CUSTOMER_EMAIL + TENANT_ID + an auto-generated
 * password). We still pass `email` and `company` explicitly to be robust
 * against env propagation hiccups; password is left empty so seedFromEnv
 * generates it (customer recovers via the magic-link / password-reset flow).
 */
async function runRemoteLooparInstall({ domain, port, tenantName, customerEmail }) {
  // Capital "S" matters: middleware.js gates `/api/System/*` from the
  // "not-installed" redirect so the install request can actually reach the
  // controller. With lowercase "/api/system/*" the middleware redirects to
  // the install page and our POST never executes.
  const url = `http://${domain}:${port}/api/System/install?app_name=loopar`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:            customerEmail || '',
      company:          tenantName,
      admin_password:   '',
      confirm_password: '',
    }),
    // The install endpoint ends with `return this.redirect("view")` — we don't
    // want to follow that redirect (it points to /desk on the tenant, which
    // requires auth we don't have from here).
    redirect: 'manual',
  });

  // Any 2xx or 3xx is OK — the install succeeded and the controller is just
  // trying to redirect us. 4xx/5xx means something failed.
  if (r.status >= 400) {
    const body = await r.text().catch(() => '<no body>');
    throw new Error(
      `Install returned ${r.status}: ${body.slice(0, 400)}`
    );
  }
  return { status: r.status };
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

function allocateFreePort() {
  const usedPorts = new Set(
    tenant.tenants().map(t => parseInt(t.env.PORT, 10)).filter(Boolean)
  );
  let port = PORT_BASE;
  while (port <= PORT_MAX && usedPorts.has(port)) port++;
  if (port > PORT_MAX) {
    throw new Error('No free port available');
  }
  return port;
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

    const port = allocateFreePort();
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

    // ---- 3) write tenant .env (CUSTOMER_EMAIL + claim verifier vars) ----
    emitProgress(subscriptionName, 'writing-env', { port, domain });
    await setSubscriptionStep(subscription, 'writing-env');

    await tenant.saveTenant({
      name:                 tenantName,
      ID:                   tenantName,
      PORT:                 port,
      DOMAIN:               domain,
      NODE_ENV:             process.env.NODE_ENV || 'development',
      CUSTOMER_EMAIL:       customerEmail,
      CLOUD_VERIFIER_URL:   claim ? getVerifierUrl()    : '',
      CLOUD_VERIFIER_TOKEN: claim ? claim.verifier_token : '',
    });

    // ---- 3b) seed db.config.json so the new tenant skips /system/connect -
    // Done before PM2 start so the tenant boots already knowing its DB.
    writeNewTenantDbConfig(tenantName);

    // ---- 4) Caddy + 5) PM2 — delegate to Tenant Manager -------------------
    // Same caddy.ensureReady() / registerTenant() + PM2 wiring the desk uses
    // when an operator creates a tenant by hand. Custom env keys we just
    // wrote (CUSTOMER_EMAIL, CLOUD_VERIFIER_*) survive Tenant Manager.save()
    // thanks to the merge-and-preserve behaviour in buildTenantEnvData.
    emitProgress(subscriptionName, 'starting', { port, domain });
    await setSubscriptionStep(subscription, 'starting');

    const tenantDoc = await loopar.newDocument('Tenant Manager', {
      id:       tenantName,
      port,
      domain,
      node_env: process.env.NODE_ENV || 'development',
    });
    tenantDoc.name = tenantName;
    tenantDoc.__IS_NEW__ = false; // .env already written; don't re-check uniqueness

    const ok = await tenantDoc.start();
    if (!ok) {
      throw new Error('Tenant Manager.start returned false');
    }

    // ---- 6) wait for tenant HTTP + auto-install Loopar -------------------
    // This is what turns the freshly-started (but empty) tenant into a real
    // Loopar workspace: creates the SQLite DB, runs alterSchema, installs
    // the `loopar` base app, and creates the Administrator user. Without
    // this, the customer would land on /loopar/system/connect — a technical
    // wizard not meant for end users.
    emitProgress(subscriptionName, 'installing-loopar', { port, domain });
    await setSubscriptionStep(subscription, 'installing-loopar');

    const isUp = await waitForTenantReady(domain, port);
    if (!isUp) {
      throw new Error(`Tenant did not become reachable on ${domain}:${port}`);
    }

    try {
      await runRemoteLooparInstall({ domain, port, tenantName, customerEmail });
    } catch (err) {
      // Install failure is fatal for the SaaS flow — the customer would land
      // on the connect wizard. Surface it loudly so the operator can retry
      // (manual reinstall) or investigate.
      throw new Error(`Auto-install failed: ${err.message}`);
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
    subscription.tenant_provisioned = 1;
    subscription.provisioning_step  = 'ready';
    await subscription.save({ validate: false });

    const url = domain.endsWith('.localhost')
      ? `http://${domain}:${port}`
      : `https://${domain}`;

    emitProgress(subscriptionName, 'ready', {
      port,
      domain,
      url,
      magic_link_sent: !!(claim && customer?.email),
    });

    console.log(`[provisioning] ${tenantName} ready on ${domain} (port ${port})`);
    return true;
  } catch (err) {
    console.error(`[provisioning] failed for ${tenantName}:`, err.message);
    emitProgress(subscriptionName, 'error', { message: err.message });
    try {
      subscription.provisioning_step = `error: ${err.message}`.slice(0, 240);
      await subscription.save({ validate: false });
    } catch (_) { /* swallow — original error is already logged */ }
    return false;
  }
}
