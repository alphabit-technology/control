'use strict';

import { BaseController, loopar, tenant } from 'loopar';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'pathe';
import { cleanupCanceledTenants } from '../../lifecycle.js';
import { runProvisioningRetrySweep } from '../../provisioning.js';
import {
  issuePortalLink,
  inspectPortalLink,
  markUsedIfFirstTime,
  buildPortalLinkUrl,
  controlPlaneBaseUrlFromReq,
} from '../../portal-link-issuer.js';
import {RESERVED_NAMES, SUBDOMAIN_RE, EMAIL_RE, PLANS_CACHE_TTL_MS, shapePrice, sortByOrder} from "./helper.js"

let plansCache = { data: null, fetchedAt: 0 };

export default class SignupController extends BaseController {

  /**
   * GET /api/signup/status?subscription_id=...
   * Public fallback for the success page: returns the latest provisioning
   * state of a Subscription so a client that missed realtime events (slow
   * connection, late reconnect) can still render the right thing.
   *
   * Intentionally returns minimal info — anyone who knows the random
   * `sub_pending_*` id (handed back to them by `/api/signup/create`) can read.
   */
  async publicActionStatus() {
    const subId = String(this.query?.subscription_id || this.data?.subscription_id || '').trim();
    if (!subId) {
      return { status: 400, success: false, message: 'subscription_id is required' };
    }

    const subscription = await loopar.getDocument('Subscription', subId);
    if (!subscription?.name) {
      return { status: 404, success: false, message: 'Subscription not found' };
    }

    const tenantName = subscription.tenant_name || null;
    const provisioned = subscription.tenant_provisioned === 1
      || subscription.tenant_provisioned === '1';

    // Build the eventual workspace URL if we have enough info. URL composition
    // (port for .localhost, no port for real domains behind Caddy) lives in
    // tenant.tenantUrl so every caller stays in sync.
    let url = null;
    if (tenantName && provisioned) {
      url = tenant.tenantUrl(tenantName);
    }

    return {
      status: 200,
      success: true,
      subscription_id: subscription.name,
      subscription_state: subscription.status,
      tenant_name: tenantName,
      tenant_provisioned: provisioned,
      provisioning_step: subscription.provisioning_step || null,
      url,
    };
  }

  /**
   * GET /api/Signup/openPortal?token=<token>
   *
   * Customer-facing entry point for the activation / billing portal emails.
   * Validates the Portal Link token, mints a *fresh* Stripe portal session,
   * and 302s the browser to it. Unlike a raw Stripe portal URL — which dies
   * in roughly an hour — the token is good until the end of the billing
   * cycle, so a customer who opens the email next morning still lands on a
   * working portal.
   *
   * On invalid / expired / revoked → renders an inline HTML page with a
   * "Email support" CTA. We pick the HTTP status (404/410/503) to be honest
   * with bots and proxies.
   *
   * NB: writes directly to this.res (302 redirect or text/html), bypassing
   * the JSON renderer. As soon as headersSent is true, renderAjax bails.
   */
  async publicActionOpenPortal() {
    const token = String(this.query?.token || '').trim();
    if (!token) {
      return this._sendPortalErrorHtml('missing_token');
    }

    const inspection = await inspectPortalLink(token);
    if (!inspection.ok) {
      return this._sendPortalErrorHtml(inspection.reason);
    }

    const subscription = await loopar.getDocument(
      'Subscription', inspection.link.subscription, null, { ifNotFound: null }
    );
    if (!subscription?.name) {
      return this._sendPortalErrorHtml('subscription_gone');
    }

    const customer = subscription.customer
      ? await loopar.getDocument('Customer', subscription.customer, null, { ifNotFound: null })
      : null;
    if (!customer?.stripe_customer_id) {
      return this._sendPortalErrorHtml('customer_missing');
    }

    const account = await loopar.getDocument(
      'Stripe Account', null, null, { ifNotFound: null }
    );
    if (!account?.secret_key) {
      console.error('[signup/openPortal] Stripe Account is not configured');
      return this._sendPortalErrorHtml('stripe_misconfigured');
    }

    let stripePortalUrl;
    try {
      const stripeClient = Stripe(account.secret_key);
      const returnUrl = tenant.tenantUrl(subscription.tenant_name);
      const session = await stripeClient.billingPortal.sessions.create({
        customer:   customer.stripe_customer_id,
        return_url: returnUrl,
      });
      stripePortalUrl = session.url;
    } catch (err) {
      console.error('[signup/openPortal] portal session failed:', err.message);
      return this._sendPortalErrorHtml('stripe_failed');
    }

    // Audit-only (multi-use within the validity window).
    await markUsedIfFirstTime(token);

    this.res.redirect(302, stripePortalUrl);
    return null;
  }

  /**
   * Render the standalone "this link doesn't work" page. Self-contained
   * HTML — no Loopar shell, since the customer probably isn't logged in
   * and shouldn't see our admin UI chrome.
   */
  _sendPortalErrorHtml(reason) {
    const titles = {
      missing_token:        'Invalid link',
      not_found:            'This link is not valid',
      expired:              'This link has expired',
      revoked:              'This link is no longer active',
      subscription_gone:    'Subscription not found',
      customer_missing:     'Customer record incomplete',
      stripe_misconfigured: 'Service temporarily unavailable',
      stripe_failed:        'Could not reach Stripe',
    };
    const messages = {
      missing_token:        'The link you clicked is missing required information. If you got here from an email, the link may have been truncated — please copy the full URL from the email body.',
      not_found:            'We could not find an activation link matching this URL. It may have been replaced by a newer one.',
      expired:              'This activation link has expired. Reply to the email it came from and we will send you a fresh one right away.',
      revoked:              'A newer activation email was sent to your inbox. Please check for the most recent one and use that link instead — only the latest is active.',
      subscription_gone:    'The subscription this link pointed to no longer exists. Please contact us so we can sort it out.',
      customer_missing:     'Your customer record is missing payment information. Please contact us — this is on our side, not yours.',
      stripe_misconfigured: 'The billing service is temporarily unavailable. Please try again in a few minutes, or contact us if the problem persists.',
      stripe_failed:        'We could not reach Stripe to open your billing portal. Please try again in a moment.',
    };

    const status = (reason === 'expired' || reason === 'revoked') ? 410
                 : (reason === 'not_found' || reason === 'missing_token' || reason === 'subscription_gone') ? 404
                 : 503;

    const supportEmail = String(process.env.CONTROL_PLANE_SUPPORT_EMAIL || 'support@loopar.build');
    const title   = titles[reason]   || 'Link error';
    const message = messages[reason] || `Something went wrong (${reason}). Please contact support.`;
    const subject = encodeURIComponent(`Help with my activation link (${reason})`);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Loopar</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background:#f6f8fa; margin:0; padding:40px 20px; color:#1a2333; }
    .card { max-width:500px; margin:60px auto; background:#fff; border-radius:12px; padding:36px; box-shadow:0 1px 3px rgba(0,0,0,0.05); }
    h1 { margin:0 0 14px 0; font-size:22px; }
    p { margin:0 0 16px 0; line-height:1.55; color:#444; }
    .actions { margin-top:28px; }
    a.btn { display:inline-block; background:#1D9E75; color:#fff; padding:11px 22px; border-radius:6px; text-decoration:none; font-weight:600; }
    .muted { color:#999; font-size:12px; margin-top:32px; text-align:center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="actions">
      <a class="btn" href="mailto:${supportEmail}?subject=${subject}">Email support</a>
    </div>
    <p class="muted">Reference: ${reason}</p>
  </div>
</body>
</html>`;

    this.res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(html);
    return null;
  }

  /**
   * GET /api/signup/plans[?category=...]
   * Returns active Stripe Prices (recurring + one_time) with their Product info.
   * Caches the full list ~5min; filters by category on each request.
   */
  async publicActionPlans() {
    const category = String(this.query?.category || '').trim().toLowerCase();
    const now = Date.now();

    let allPlans;
    let cached = false;

    if (plansCache.data && (now - plansCache.fetchedAt) < PLANS_CACHE_TTL_MS) {
      allPlans = plansCache.data;
      cached = true;
    } else {
      const account = await loopar.getDocument('Stripe Account');
      const secretKey = account?.secret_key;
      if (!secretKey) {
        console.error('[signup] Stripe Account is not configured');
        return { status: 500, success: false, message: 'Stripe is not configured' };
      }
      try {
        const stripeClient = Stripe(secretKey);
        const list = await stripeClient.prices.list({
          active: true,
          limit: 100,
          expand: ['data.product'],
        });
        allPlans = list.data
          .filter(p => p.product && p.product.active !== false)
          .map(shapePrice);
        plansCache = { data: allPlans, fetchedAt: now };
      } catch (err) {
        console.error('[signup] prices.list failed:', err.message);
        return { status: 500, success: false, message: 'Failed to load plans' };
      }
    }

    let plans = allPlans;
    if (category) {
      plans = plans.filter(p =>
        String(p.product_metadata?.category || '').toLowerCase() === category
      );
    }
    plans = [...plans].sort(sortByOrder);

    return { status: 200, success: true, plans, cached, category: category || null };
  }

  /**
   * POST /api/signup/create
   */
  async publicActionCreate() {
    const data = this.data || {};
    const priceId = String(data.price_id || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const workspaceName = String(data.workspace_name || '').trim().toLowerCase();
    const rawAmount = data.amount;

    if (!priceId || !email) {
      return { status: 400, success: false, message: 'price_id and email are required' };
    }
    if (!EMAIL_RE.test(email)) {
      return { status: 400, success: false, message: 'Invalid email' };
    }

    const account = await loopar.getDocument('Stripe Account');
    const secretKey = account?.secret_key;
    if (!secretKey) {
      console.error('[signup] Stripe Account is not configured');
      return { status: 500, success: false, message: 'Stripe is not configured' };
    }
    const stripeClient = Stripe(secretKey);

    let price;
    try {
      price = await stripeClient.prices.retrieve(priceId, { expand: ['product'] });
    } catch (err) {
      console.error('[signup] prices.retrieve failed:', err.message);
      return { status: 400, success: false, message: 'Invalid price' };
    }
    if (!price.active) {
      return { status: 400, success: false, message: 'Price is not active' };
    }
    if (price.type !== 'recurring' && price.type !== 'one_time') {
      return { status: 400, success: false, message: 'Unsupported price type' };
    }

    const productMeta = price.product?.metadata || {};
    const category = String(productMeta.category || 'cloud').toLowerCase();
    const planName = price.product?.name || priceId;
    const isCloud = category === 'cloud';
    const isCustomAmount = !!price.custom_unit_amount;

    let customCents = null;
    if (isCustomAmount) {
      const amountNum = Number(rawAmount);
      if (!rawAmount || !Number.isFinite(amountNum) || amountNum <= 0) {
        return { status: 400, success: false, message: 'amount is required for this price' };
      }
      customCents = Math.round(amountNum * 100);
      const cuMin = price.custom_unit_amount.minimum;
      const cuMax = price.custom_unit_amount.maximum;
      if (cuMin && customCents < cuMin) {
        return { status: 400, success: false, message: `Amount below minimum ($${(cuMin/100).toFixed(2)})` };
      }
      if (cuMax && customCents > cuMax) {
        return { status: 400, success: false, message: `Amount above maximum ($${(cuMax/100).toFixed(2)})` };
      }
    }

    let port = null;
    if (isCloud) {
      if (!workspaceName) {
        return { status: 400, success: false, message: 'workspace_name is required for this plan' };
      }
      if (!SUBDOMAIN_RE.test(workspaceName)) {
        return { status: 400, success: false, message: 'Invalid workspace name (lowercase, 3-30 chars, must start with a letter)' };
      }
      if (RESERVED_NAMES.has(workspaceName)) {
        return { status: 400, success: false, message: 'That workspace name is reserved' };
      }
      if (fs.existsSync(path.join(process.cwd(), 'sites', workspaceName))) {
        return { status: 400, success: false, message: 'That workspace name is already taken' };
      }
      // Two concurrent signups could pick the same port. Acceptable
      // while signups are infrequent; under load, replace with a DB lock or
      // a sequence. allocateFreePort scans the live tenant set under sites/.
      try {
        port = tenant.allocateFreePort();
      } catch (err) {
        console.error('[signup] allocateFreePort failed:', err.message);
        return { status: 500, success: false, message: 'No free port available' };
      }
    }

    //Customer by email
    let customer;
    const existingName = await loopar.db.getValue('Customer', 'email', email, { ifNotFound: false });
    if (existingName) {
      customer = await loopar.getDocument('Customer', existingName);
    } else {
      customer = await loopar.newDocument('Customer');
      customer.name = email;
      customer.email  = email;
      customer.status = 'active';
      try {
        await customer.save();
      } catch (err) {
        console.error('[signup] failed to save Customer:', err.message);
        return { status: 500, success: false, message: 'Failed to register customer' };
      }
    }

    // ---- create pending Subscription record ----------------------------
    // We use the `Subscription` entity as a generic "pending purchase" record,
    // whether the underlying Stripe charge is a subscription or a one-time
    // payment. Tenant fields are only populated for cloud purchases.
    const subName = 'sub_pending_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try {
      const subscription = await loopar.newDocument('Subscription');
      subscription.name = subName;
      subscription.customer = customer.name;
      subscription.stripe_price_id = priceId;
      subscription.plan_name = planName;
      subscription.status = 'pending';
      if (isCloud) {
        subscription.tenant_name = workspaceName;
        subscription.port = port;
      }
      await subscription.save();
    } catch (err) {
      console.error('[signup] failed to save Subscription:', err.message);
      return { status: 500, success: false, message: 'Failed to create subscription' };
    }

    const proto = this.req?.headers?.['x-forwarded-proto'] || this.req?.protocol || 'http';
    const host = this.req?.headers?.host || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;
    const mode = price.type === 'recurring' ? 'subscription' : 'payment';

    let lineItems;
    if (isCustomAmount) {
      lineItems = [{
        price_data: {
          currency: price.currency,
          product: price.product.id,
          unit_amount: customCents,
          ...(price.type === 'recurring' ? {
            recurring: {
              interval: price.recurring.interval,
              interval_count: price.recurring.interval_count || 1,
            },
          } : {}),
        },
        quantity: 1,
      }];
    } else {
      lineItems = [{ price: priceId, quantity: 1 }];
    }

    const metadata = {
      subscription_id: subName,
      plan_name:       planName,
      price_id:        priceId,
      category,
      ...(isCloud ? { tenant_name: workspaceName } : {}),
    };

    const sessionParams = {
      mode,
      line_items: lineItems,
      customer_email: email,
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&subscription_id=${encodeURIComponent(subName)}`,
      cancel_url: `${baseUrl}/cancel?subscription_id=${encodeURIComponent(subName)}`,
      metadata,
    };
    if (mode === 'subscription') {
      // Propagate metadata to the resulting Stripe Subscription so renewal /
      // cancellation events can also find our local row.
      sessionParams.subscription_data = { metadata };
    }

    try {
      const session = await stripeClient.checkout.sessions.create(sessionParams);
      return {
        status: 200,
        success: true,
        url:             session.url,
        subscription_id: subName,
        session_id:      session.id,
      };
    } catch (err) {
      console.error('[signup] Stripe checkout.sessions.create failed:', err.message);
      return { status: 500, success: false, message: 'Failed to create Checkout session' };
    }
  }

  /**
   * POST /api/Signup/cleanupCanceled (authenticated — operator only)
   *
   * Hard-deletes tenants whose Subscription was canceled more than
   * CLOUD_DELETE_AFTER_DAYS ago. Designed to be triggered from a daily
   * OS cron. Idempotent. Returns count of tenants removed.
   *
   * Example cron entry (every day at 03:00 local time):
   *   0 3 * * *  curl -s -X POST \
   *     -H "Cookie: $LOOPAR_COOKIE" \
   *     -H "X-CSRF-Token: $LOOPAR_CSRF" \
   *     http://localhost:3003/api/Signup/cleanupCanceled
   */
  async actionCleanupCanceled() {
    try {
      const removed = await cleanupCanceledTenants();
      return { status: 200, success: true, removed };
    } catch (err) {
      console.error('[signup/cleanupCanceled] failed:', err.message);
      return { status: 500, success: false, message: err.message };
    }
  }

  /**
   * POST /api/Signup/retryProvisioning  (authenticated — operator only)
   *
   * Sweep Subscriptions whose provisioning is overdue for a retry and
   * re-invoke `provisionTenant` on each one IN SERIES (PM2 / Caddy / install
   * are too heavyweight to fan out). Designed to be triggered from a 1-min
   * OS cron, and also called once from the control-plane boot hook to
   * recover anything that was mid-flight during a crash.
   *
   * Candidates: status in (active, trialing) AND tenant not yet provisioned
   * AND retry_after <= now AND attempts < MAX. The `provisioning_retry_after`
   * filter doubles as the "already in flight" guard — the success path
   * clears it, so a Subscription only matches when the prior attempt has
   * truly given up (and is therefore safe to re-run, since provisionTenant
   * is idempotent at its entry guard).
   *
   * Example cron (every minute):
   *   * * * * *  curl -s -X POST \
   *     -H "Cookie: $LOOPAR_COOKIE" \
   *     -H "X-CSRF-Token: $LOOPAR_CSRF" \
   *     http://localhost:3003/api/Signup/retryProvisioning
   */
  async actionRetryProvisioning() {
    try {
      const out = await runProvisioningRetrySweep();
      return { status: 200, success: true, ...out };
    } catch (err) {
      console.error('[signup/retryProvisioning] failed:', err.message);
      return { status: 500, success: false, message: err.message };
    }
  }

  /**
   * GET /api/Signup/listAvailableTenants   (authenticated — operator only)
   *
   * Returns tenants in `sites/` that do NOT have an active/trialing
   * Subscription. Used by the "New Subscription for existing tenant" modal
   * to populate the tenant selector. Excludes control-plane tenants
   * (`dev`, `cloud`, `loopar`) which never get billed.
   */
  async actionListAvailableTenants() {
    const excluded = new Set(['dev', 'cloud', 'loopar']);
    const all = tenant.tenants();
    const available = [];
    for (const t of all) {
      if (!t?.name || excluded.has(t.name)) continue;
      const existingSubName = await loopar.db.getValue(
        'Subscription', 'tenant_name', t.name, { ifNotFound: null }
      );
      let blocked = false;
      if (existingSubName) {
        const existing = await loopar.getDocument('Subscription', existingSubName);
        blocked = ['active', 'trialing'].includes(existing?.status);
      }
      if (!blocked) {
        available.push({
          name:   t.name,
          domain: t.env?.DOMAIN || `${t.name}.localhost`,
          port:   t.env?.PORT || null,
        });
      }
    }
    available.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, success: true, tenants: available };
  }

  /**
   * POST /api/Signup/createForExisting (authenticated — operator only)
   *
   * Associate a Stripe Subscription with a tenant that ALREADY exists. The
   * tenant is NOT re-provisioned; we only create the Stripe Subscription
   * (one of three modes) and the local Subscription row that links them.
   *
   * body:
   *   tenant_name — must exist in sites/
   *   price_id — active Stripe Price
   *   email — customer's email (becomes/finds the Customer)
   *   mode — 'checkout' | 'trial' | 'scheduled'
   *   trial_days? — required when mode==='trial' (default 30)
   *   billing_anchor?— ISO date string when mode==='scheduled'
   *                    (default: first day of next month)
   *
   * Modes:
   *   - checkout : returns a Stripe Checkout URL for the operator to send
   *                to the customer. Sub becomes `active` after they pay.
   *   - trial    : Sub created in `trialing` with payment_behavior
   *                `default_incomplete`. No card required. We email the
   *                customer with a Customer Portal link to add one.
   *   - scheduled: Sub created with `billing_cycle_anchor` at the given
   *                date. First charge happens on that date.
   *
   * Returns `{ checkout_url? , portal_url?, subscription_id, status, ... }`.
   */
  async actionCreateForExisting() {
    const data = this.data || {};
    const tenantName = String(data.tenant_name || '').trim();
    const priceId = String(data.price_id || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const mode = String(data.mode || '').trim().toLowerCase();

    // Optional setup fee (cents). One-off charge on top of the recurring plan
    // — typical use case is a development/onboarding charge that varies per
    // project. Default: billed on the first invoice. If `setup_fee_installments`
    // is > 1, split into that many monthly installments via a parallel Stripe
    // Subscription Schedule that auto-cancels when done (trial/scheduled only).
    const setupFeeCents = data.setup_fee_cents != null
      ? Math.round(Number(data.setup_fee_cents))
      : 0;
    const setupFeeLabel = String(data.setup_fee_label || 'Setup fee').slice(0, 80);
    const setupFeeInstallments = data.setup_fee_installments != null
      ? Math.max(1, Math.min(12, parseInt(data.setup_fee_installments, 10) || 1))
      : 1;

    // ---- validate basics -----------------------------------------------
    if (!tenantName) return { status: 400, success: false, message: 'tenant_name is required' };
    if (!priceId) return { status: 400, success: false, message: 'price_id is required' };
    if (!email) return { status: 400, success: false, message: 'email is required' };
    if (!EMAIL_RE.test(email)) {
      return { status: 400, success: false, message: 'Invalid email' };
    }
    if (!['checkout', 'trial', 'scheduled'].includes(mode)) {
      return { status: 400, success: false, message: 'mode must be checkout, trial or scheduled' };
    }
    if (setupFeeCents < 0 || setupFeeCents > 1000000) {
      // 0 = no setup fee, $1M cap to catch obviously-wrong inputs
      return { status: 400, success: false, message: 'setup_fee_cents must be 0..1000000' };
    }
    if (setupFeeInstallments > 1 && mode === 'checkout') {
      return {
        status: 400,
        success: false,
        message: 'Installments are only supported for trial/scheduled modes — Checkout is one-shot.',
      };
    }

    // ---- tenant exists? -------------------------------------------------
    if (!fs.existsSync(path.join(process.cwd(), 'sites', tenantName, '.env'))) {
      return { status: 404, success: false, message: `Tenant "${tenantName}" does not exist` };
    }

    // ---- tenant already has an active sub? ------------------------------
    const existingSubName = await loopar.db.getValue(
      'Subscription', 'tenant_name', tenantName, { ifNotFound: null }
    );
    if (existingSubName) {
      const existing = await loopar.getDocument('Subscription', existingSubName);
      if (['active', 'trialing'].includes(existing?.status)) {
        return {
          status: 409,
          success: false,
          message: `Tenant "${tenantName}" already has an active subscription (${existing.name})`,
        };
      }
    }

    // ---- Stripe ready? --------------------------------------------------
    const account = await loopar.getDocument('Stripe Account');
    const secretKey = account?.secret_key;
    if (!secretKey) {
      return { status: 500, success: false, message: 'Stripe is not configured' };
    }
    const stripeClient = Stripe(secretKey);

    // ---- validate price -------------------------------------------------
    let price;
    try {
      price = await stripeClient.prices.retrieve(priceId, { expand: ['product'] });
    } catch (err) {
      return { status: 400, success: false, message: 'Invalid price' };
    }
    if (!price.active) {
      return { status: 400, success: false, message: 'Price is not active' };
    }
    if (price.type !== 'recurring') {
      return { status: 400, success: false, message: 'Only recurring prices are supported here' };
    }

    const planName = price.product?.name || priceId;

    // Find or create the local Customer row.
    let customer;
    const existingCustomerName = await loopar.db.getValue('Customer', 'email', email, { ifNotFound: false });
    if (existingCustomerName) {
      customer = await loopar.getDocument('Customer', existingCustomerName);
    } else {
      customer = await loopar.newDocument('Customer');
      customer.name   = email;
      customer.email  = email;
      customer.status = 'active';
      try {
        await customer.save();
      } catch (err) {
        console.error('[signup/createForExisting] failed to save Customer:', err.message);
        return { status: 500, success: false, message: 'Failed to register customer' };
      }
    }

    // Trial and scheduled modes call subscriptions.create directly, so we
    // need a Stripe Customer id up front (Checkout would create one from
    // `customer_email` for us). Look in Stripe first to avoid creating a
    // duplicate if we already made one in a prior attempt. The local update
    // goes through `db.updateRow` because `doc.save()` on a row loaded via
    // getDocument was emitting an INSERT and tripping the unique constraint.
    if (mode !== 'checkout' && !customer.stripe_customer_id) {
      try {
        let stripeCustomerId = null;
        const existing = await stripeClient.customers.list({ email, limit: 1 });
        if (existing.data.length > 0) {
          stripeCustomerId = existing.data[0].id;
        } else {
          const stripeCustomer = await stripeClient.customers.create({ email });
          stripeCustomerId = stripeCustomer.id;
        }
        await loopar.db.updateRow('Customer', customer.name, { stripe_customer_id: stripeCustomerId });
        customer.stripe_customer_id = stripeCustomerId;
      } catch (err) {
        console.error('[signup/createForExisting] ensure Stripe customer failed:', err.message);
        return { status: 500, success: false, message: `Could not ensure Stripe customer: ${err.message}` };
      }
    }

    const subName = 'sub_oper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const metadata = {
      subscription_id:  subName,
      tenant_name:      tenantName,
      existing_tenant:  'true',
      plan_name:        planName,
      price_id:         priceId,
      created_by:       'operator',
    };

    // ---- branch on mode -------------------------------------------------
    let stripeSub = null;
    let checkoutUrl = null;

    // For Checkout we attach the setup fee as an additional one-off line_item
    // (mode 'subscription' accepts a mix of recurring + one-off line items
    // and one-off supports `price_data.product_data` for inline product
    // creation — that's where the custom label lives for this mode).
    const checkoutSetupLineItem = setupFeeCents > 0 ? {
      price_data: {
        currency:     (price.currency || 'usd'),
        product_data: { name: setupFeeLabel },
        unit_amount:  setupFeeCents,
      },
      quantity: 1,
    } : null;

    if (mode === 'checkout') {
      const proto = this.req?.headers?.['x-forwarded-proto'] || this.req?.protocol || 'http';
      const host  = this.req?.headers?.host || 'localhost';
      const baseUrl = `${proto}://${host}`;
      try {
        const lineItems = [{ price: priceId, quantity: 1 }];
        if (checkoutSetupLineItem) lineItems.push(checkoutSetupLineItem);

        const sessionParams = {
          mode: 'subscription',
          line_items: lineItems,
          customer_email: email,
          success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&subscription_id=${encodeURIComponent(subName)}`,
          cancel_url:  `${baseUrl}/cancel?subscription_id=${encodeURIComponent(subName)}`,
          metadata,
          subscription_data: { metadata },
        };
        const session = await stripeClient.checkout.sessions.create(sessionParams);
        checkoutUrl = session.url;
      } catch (err) {
        console.error('[signup/createForExisting] checkout.sessions.create failed:', err.message);
        return { status: 500, success: false, message: 'Failed to create Checkout session' };
      }
    } else if (mode === 'trial') {
      const trialDays = Math.max(1, Math.min(365, parseInt(data.trial_days, 10) || 30));
      try {
        stripeSub = await stripeClient.subscriptions.create({
          customer: customer.stripe_customer_id,
          items:    [{ price: priceId }],
          trial_period_days:   trialDays,
          payment_behavior:    'default_incomplete',
          payment_settings:    { save_default_payment_method: 'on_subscription' },
          expand:              ['latest_invoice.payment_intent'],
          metadata,
        });
      } catch (err) {
        console.error('[signup/createForExisting] subscriptions.create (trial) failed:', err.message);
        return { status: 500, success: false, message: `Failed to create trial Subscription: ${err.message}` };
      }
    } else if (mode === 'scheduled') {
      // billing_cycle_anchor must be a future Unix timestamp. Default: first
      // day of next month at 00:00:00 UTC.
      let anchorDate;
      if (data.billing_anchor) {
        anchorDate = new Date(data.billing_anchor);
        if (Number.isNaN(anchorDate.getTime())) {
          return { status: 400, success: false, message: 'Invalid billing_anchor date' };
        }
      } else {
        const now = new Date();
        anchorDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
      }
      if (anchorDate.getTime() < Date.now()) {
        return { status: 400, success: false, message: 'billing_anchor must be in the future' };
      }
      const anchorTs = Math.floor(anchorDate.getTime() / 1000);
      try {
        stripeSub = await stripeClient.subscriptions.create({
          customer:              customer.stripe_customer_id,
          items:                 [{ price: priceId }],
          billing_cycle_anchor:  anchorTs,
          proration_behavior:    'none',
          // Stripe requires a default payment method when not in trial — flag
          // for the operator to send the Customer Portal link.
          payment_behavior:      'default_incomplete',
          payment_settings:      { save_default_payment_method: 'on_subscription' },
          expand:                ['latest_invoice.payment_intent'],
          metadata: { ...metadata, billing_anchor: anchorDate.toISOString() },
        });
      } catch (err) {
        console.error('[signup/createForExisting] subscriptions.create (scheduled) failed:', err.message);
        return { status: 500, success: false, message: `Failed to schedule Subscription: ${err.message}` };
      }
    }

    // Setup fee for trial/scheduled. Two delivery modes:
    //   - Single payment (installments <= 1): attach as an InvoiceItem on the
    //     plan's upcoming invoice. `description` carries the per-project label.
    //   - Installments (> 1): create a parallel Stripe Subscription Schedule
    //     with `iterations: N` that charges (fee/N) per month and auto-cancels
    //     when the iterations are done. The customer sees two Subscriptions
    //     in their Customer Portal (the plan + the setup) until the schedule
    //     finishes, then only the plan remains.
    let setupScheduleId = null;
    if (stripeSub && setupFeeCents > 0) {
      try {
        if (setupFeeInstallments > 1) {
          const perInstallmentCents = Math.round(setupFeeCents / setupFeeInstallments);
          // Stripe rejects price_data.product_data inside subscriptionSchedules
          // phases — it only accepts an existing product id. Create a one-off
          // Product per schedule so the operator-chosen label survives onto
          // the customer's invoices.
          // Description is what the Customer Portal shows under the line item,
          // so we use it to make the installments explicit ("4 × $400 = $1,600
          // total, auto-cancels"). Without this the customer only sees one
          // monthly amount and may think it's the whole charge.
          const currencyUpper = (price.currency || 'usd').toUpperCase();
          const perPretty   = (perInstallmentCents / 100).toFixed(2);
          const totalPretty = (setupFeeCents / 100).toFixed(2);
          const setupProduct = await stripeClient.products.create({
            name: setupFeeLabel,
            description:
              `${setupFeeInstallments} monthly installments of ${currencyUpper} ${perPretty} ` +
              `(total ${currencyUpper} ${totalPretty}). Auto-cancels after the final payment.`,
            metadata: { ...metadata, kind: 'setup_installments' },
          });
          // Use end_date instead of iterations — `iterations` is rejected on
          // older API versions; end_date works everywhere. N monthly intervals
          // = N months from now.
          const now = new Date();
          const phaseEnd = new Date(now);
          phaseEnd.setUTCMonth(phaseEnd.getUTCMonth() + setupFeeInstallments);
          const phaseEndTs = Math.floor(phaseEnd.getTime() / 1000);

          const schedule = await stripeClient.subscriptionSchedules.create({
            customer:     customer.stripe_customer_id,
            start_date:   'now',
            end_behavior: 'cancel',
            phases: [{
              items: [{
                price_data: {
                  currency:    (price.currency || 'usd'),
                  product:     setupProduct.id,
                  unit_amount: perInstallmentCents,
                  recurring:   { interval: 'month' },
                },
                quantity: 1,
              }],
              end_date: phaseEndTs,
              metadata: { ...metadata, kind: 'setup_installments' },
            }],
            metadata: { ...metadata, kind: 'setup_installments' },
          });
          setupScheduleId = schedule.id;
        } else {
          await stripeClient.invoiceItems.create({
            customer:     customer.stripe_customer_id,
            amount:       setupFeeCents,
            currency:     (price.currency || 'usd'),
            description:  setupFeeLabel,
            subscription: stripeSub.id,
          });
        }
      } catch (err) {
        // The plan Subscription is already in Stripe; if we can't attach the
        // setup fee, surface a partial-success so the operator can add it
        // manually from the Stripe dashboard instead of dropping it silently.
        const what = setupFeeInstallments > 1 ? 'setup schedule' : 'setup invoice item';
        console.error(`[signup/createForExisting] ${what} failed:`, err.message);
        return {
          status: 502,
          success: false,
          message:
            `Subscription created in Stripe (${stripeSub.id}) but the ${what} could ` +
            `not be attached: ${err.message}. Add it manually in the Stripe dashboard.`,
        };
      }
    }

    // ---- save local Subscription ---------------------------------------
    try {
      const subscription = await loopar.newDocument('Subscription');
      subscription.name               = subName;
      subscription.customer           = customer.name;
      subscription.stripe_price_id    = priceId;
      subscription.plan_name          = planName;
      subscription.tenant_name        = tenantName;
      subscription.tenant_provisioned = 1;          // already exists
      subscription.provisioning_step  = 'ready';
      if (stripeSub) {
        subscription.stripe_subscription_id = stripeSub.id;
        subscription.status                  = stripeSub.status;   // 'trialing' / 'incomplete' / ...
      } else {
        subscription.status = 'pending';                            // checkout mode — wait for webhook
      }
      await subscription.save();
    } catch (err) {
      console.error('[signup/createForExisting] save Subscription failed:', err.message);
      return { status: 500, success: false, message: 'Subscription saved in Stripe but failed locally — reconcile manually' };
    }

    // ---- Activation link (for trial / scheduled) ----------------------
    // Mint a Portal Link tied to the billing-cycle end. The link is a
    // stable Loopar URL that, when clicked, generates a fresh Stripe
    // portal session — so the email button keeps working until end of
    // period instead of expiring an hour after we send it.
    let actionUrl     = null;
    let linkExpiresAt = null;
    if (stripeSub && customer.stripe_customer_id && (mode === 'trial' || mode === 'scheduled')) {
      try {
        const nowSec     = Math.floor(Date.now() / 1000);
        const SEVEN_DAYS = 7 * 24 * 60 * 60;
        linkExpiresAt = new Date(
          ((stripeSub.current_period_end && stripeSub.current_period_end > nowSec)
            ? stripeSub.current_period_end
            : nowSec + SEVEN_DAYS) * 1000
        );
        const { token } = await issuePortalLink(subscription.name, linkExpiresAt);
        actionUrl = buildPortalLinkUrl(token, controlPlaneBaseUrlFromReq(this.req));
      } catch (err) {
        // Non-fatal — the operator can re-issue via the Resend modal later.
        console.warn('[signup/createForExisting] issuePortalLink failed:', err.message);
      }
    }

    // Trial / scheduled: email the customer the activation link so they can
    // add a card before the first real charge. Checkout doesn't get an
    // automatic email — the operator forwards the Checkout URL directly.
    //
    // We also pass setup-fee info so the email can spell out installments
    // explicitly (the Customer Portal only shows the next monthly amount,
    // which can be misread as the total).
    const setupInfo = setupFeeCents > 0 ? {
      totalCents:   setupFeeCents,
      installments: setupFeeInstallments,
      currency:     (price.currency || 'usd'),
      label:        setupFeeLabel,
    } : null;

    if (actionUrl && (mode === 'trial' || mode === 'scheduled')) {
      try {
        if (mode === 'trial') {
          await sendTrialStartEmail({
            to:            email,
            tenantName,
            planName,
            trialEnd:      stripeSub.trial_end,
            actionUrl,
            linkExpiresAt,
            setup:         setupInfo,
          });
        } else {
          // `current_period_end` on a scheduled Sub equals the billing anchor —
          // i.e. when Stripe will attempt the first charge.
          const firstChargeAt = stripeSub.current_period_end || null;
          await sendScheduledStartEmail({
            to:            email,
            tenantName,
            planName,
            firstChargeAt,
            actionUrl,
            linkExpiresAt,
            setup:         setupInfo,
          });
        }
      } catch (err) {
        // Email failure is non-fatal — Sub exists, operator can resend.
        console.warn('[signup/createForExisting] activation email failed:', err.message);
      }
    }

    return {
      status:           200,
      success:          true,
      subscription_id:  subName,
      stripe_subscription_id: stripeSub?.id || null,
      stripe_status:    stripeSub?.status || null,
      trial_end:        stripeSub?.trial_end || null,
      checkout_url:     checkoutUrl,
      portal_url:       actionUrl,   // Loopar deep link (regenerates Stripe session on click)
      setup_schedule_id:        setupScheduleId,
      setup_fee_installments:   setupFeeCents > 0 ? setupFeeInstallments : 0,
      message:          mode === 'checkout'
        ? 'Send the Checkout URL to the customer.'
        : mode === 'trial'
          ? 'Trial started. The customer received an email to add a payment method.'
          : 'Subscription scheduled. Send the portal URL to the customer to add a payment method.',
    };
  }

  /**
   * GET /api/Signup/listResendableSubscriptions   (authenticated — operator only)
   *
   * Returns Subscriptions whose customer would benefit from a fresh
   * "activation" email — anything where the Sub exists in Stripe but the
   * customer still needs to add a payment method or recover from a payment
   * failure. Used by the "Resend activation email" modal selector.
   */
  async actionListResendableSubscriptions() {
    const rows = await loopar.db.getAll(
      'Subscription',
      ['name', 'tenant_name', 'plan_name', 'status', 'customer', 'stripe_subscription_id']
    );
    const resendable = new Set(['incomplete', 'trialing', 'past_due', 'pending', 'active']);
    const items = [];
    for (const r of rows || []) {
      if (!r?.stripe_subscription_id) continue;
      if (!resendable.has(r.status)) continue;
      const customer = r.customer
        ? await loopar.getDocument('Customer', r.customer)
        : null;
      items.push({
        name:        r.name,
        tenant_name: r.tenant_name,
        plan_name:   r.plan_name,
        status:      r.status,
        email:       customer?.email || null,
      });
    }
    items.sort((a, b) => (a.tenant_name || '').localeCompare(b.tenant_name || ''));
    return { status: 200, success: true, subscriptions: items };
  }

  /**
   * POST /api/Signup/resendActivationEmail   (authenticated — operator only)
   *
   * For a Subscription that's already in Stripe, generates a fresh Customer
   * Portal session and re-sends the activation email. Picks the right copy
   * (trial vs scheduled) by inspecting the live Stripe Subscription, so the
   * customer gets a coherent message even if the local row drifted.
   *
   * body: { subscription_name }   — Loopar Subscription `name`
   */
  async actionResendActivationEmail() {
    const subName = String(this.data?.subscription_name || '').trim();
    if (!subName) {
      return { status: 400, success: false, message: 'subscription_name is required' };
    }

    const subscription = await loopar.getDocument('Subscription', subName);
    if (!subscription?.name) {
      return { status: 404, success: false, message: `Subscription "${subName}" not found` };
    }
    if (!subscription.stripe_subscription_id) {
      return {
        status: 409,
        success: false,
        message: 'This Subscription has no Stripe id yet — there is nothing to resend.',
      };
    }

    const customer = subscription.customer
      ? await loopar.getDocument('Customer', subscription.customer)
      : null;
    if (!customer?.email || !customer.stripe_customer_id) {
      return {
        status: 409,
        success: false,
        message: 'Customer is missing email or Stripe customer id.',
      };
    }

    const account = await loopar.getDocument('Stripe Account');
    const secretKey = account?.secret_key;
    if (!secretKey) {
      return { status: 500, success: false, message: 'Stripe is not configured' };
    }
    const stripeClient = Stripe(secretKey);

    // Read the Stripe Sub so we know whether to send the trial or scheduled
    // copy, and so we can include the setup fee block when applicable.
    let stripeSub;
    try {
      stripeSub = await stripeClient.subscriptions.retrieve(
        subscription.stripe_subscription_id,
        { expand: ['items.data.price.product'] }
      );
    } catch (err) {
      console.error('[signup/resendActivation] subscriptions.retrieve failed:', err.message);
      return { status: 502, success: false, message: `Could not load Stripe Subscription: ${err.message}` };
    }

    // Mint a fresh Portal Link tied to the billing cycle end. We don't create
    // the Stripe portal session here anymore — that happens on click, so each
    // visit gets a fresh session (no more "link expired after 1h" complaints).
    // The token revokes any previous link for this sub, so the older email
    // button goes dead the moment the operator sends a new one.
    const nowSec        = Math.floor(Date.now() / 1000);
    const SEVEN_DAYS    = 7 * 24 * 60 * 60;
    const linkExpiresAt = new Date(
      ((stripeSub.current_period_end && stripeSub.current_period_end > nowSec)
        ? stripeSub.current_period_end
        : nowSec + SEVEN_DAYS) * 1000
    );
    let actionUrl;
    try {
      const { token } = await issuePortalLink(subscription.name, linkExpiresAt);
      actionUrl = buildPortalLinkUrl(token, controlPlaneBaseUrlFromReq(this.req));
    } catch (err) {
      console.error('[signup/resendActivation] issuePortalLink failed:', err.message);
      return { status: 500, success: false, message: `Could not issue portal link: ${err.message}` };
    }

    // Look for a parallel setup-installments schedule on the same customer
    // (created at signup time, tagged in metadata). If present, we surface
    // its details in the email block.
    let setupInfo = null;
    try {
      const schedules = await stripeClient.subscriptionSchedules.list({
        customer: customer.stripe_customer_id,
        limit:    20,
      });
      const match = (schedules.data || []).find(s =>
        s?.metadata?.subscription_id === subscription.name &&
        s?.metadata?.kind === 'setup_installments' &&
        ['active', 'not_started'].includes(s.status)
      );
      if (match) {
        const phase = match.phases?.[0];
        const item  = phase?.items?.[0];
        const per   = item?.price?.unit_amount || 0;
        const start = phase?.start_date ? new Date(phase.start_date * 1000) : new Date();
        const end   = phase?.end_date   ? new Date(phase.end_date * 1000)   : null;
        const months = end
          ? Math.max(1, Math.round((end.getTime() - start.getTime()) / (30 * 24 * 60 * 60 * 1000)))
          : 1;
        setupInfo = {
          totalCents:   per * months,
          installments: months,
          currency:     item?.price?.currency || 'usd',
          label:        item?.price?.product?.name || 'Setup fee',
        };
      }
    } catch (err) {
      // Non-fatal — email goes out without the setup block.
      console.warn('[signup/resendActivation] could not inspect setup schedule:', err.message);
    }

    const planName = subscription.plan_name
      || stripeSub.items?.data?.[0]?.price?.product?.name
      || 'your plan';

    try {
      if (stripeSub.status === 'trialing' || stripeSub.trial_end) {
        await sendTrialStartEmail({
          to:            customer.email,
          tenantName:    subscription.tenant_name,
          planName,
          trialEnd:      stripeSub.trial_end,
          actionUrl,
          linkExpiresAt,
          setup:         setupInfo,
        });
      } else if (stripeSub.status === 'active') {
        // Customer is already paying — they lost their original link and need
        // the Portal back for invoice / payment / cancel actions.
        await sendPortalAccessEmail({
          to:            customer.email,
          tenantName:    subscription.tenant_name,
          planName,
          actionUrl,
          linkExpiresAt,
          setup:         setupInfo,
        });
      } else {
        await sendScheduledStartEmail({
          to:            customer.email,
          tenantName:    subscription.tenant_name,
          planName,
          firstChargeAt: stripeSub.current_period_end || null,
          actionUrl,
          linkExpiresAt,
          setup:         setupInfo,
        });
      }
    } catch (err) {
      console.error('[signup/resendActivation] email send failed:', err.message);
      return { status: 502, success: false, message: `Email send failed: ${err.message}`, portal_url: actionUrl };
    }

    return {
      status:     200,
      success:    true,
      message:    `Activation email re-sent to ${customer.email}.`,
      portal_url: actionUrl,   // kept legacy field name for the existing UI modal
    };
  }
}

/**
 * Render an HTML block describing the setup fee, used as a callout in
 * activation emails. Returns empty string when there's no fee.
 */
function renderSetupFeeBlock(setup) {
  if (!setup || !setup.totalCents) return '';
  const cur   = (setup.currency || 'usd').toUpperCase();
  const total = (setup.totalCents / 100).toFixed(2);
  const label = setup.label || 'Setup fee';

  if (setup.installments > 1) {
    const per = (setup.totalCents / setup.installments / 100).toFixed(2);
    return `
      <div style="background:#f6f8fa;border-radius:8px;padding:14px 16px;margin:20px 0;font-size:13px;color:#444">
        <strong>${label}:</strong> ${cur} ${total} total, billed as
        <strong>${setup.installments} monthly payments of ${cur} ${per}</strong>.
        These run alongside your plan and end automatically after the last payment.
      </div>
    `;
  }
  return `
    <div style="background:#f6f8fa;border-radius:8px;padding:14px 16px;margin:20px 0;font-size:13px;color:#444">
      <strong>${label}:</strong> ${cur} ${total}, billed once on your first invoice.
    </div>
  `;
}

/**
 * Trial-start email — sent right after the operator opens a trial Subscription
 * for an existing tenant. Mirrors the "trial about to end" reminder that the
 * webhook handler sends, so customers get a consistent voice on both ends.
 */
async function sendTrialStartEmail({ to, tenantName, planName, trialEnd, actionUrl, linkExpiresAt, setup }) {
  const trialEndDate = trialEnd ? new Date(trialEnd * 1000).toUTCString() : 'a future date';
  const subject = `Your ${tenantName} workspace is on trial — add payment to continue`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
      <h2 style="margin: 0 0 16px 0;">Your workspace is active</h2>
      <p>Your subscription to <strong>${planName}</strong> is now active in trial mode for <strong>${tenantName}</strong>.</p>
      <p>The trial ends on <strong>${trialEndDate}</strong>. To keep your workspace running without interruption,
         add a payment method before the trial ends:</p>
      ${renderSetupFeeBlock(setup)}
      <p style="margin: 28px 0;">
        <a href="${actionUrl}"
           style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Add payment method
        </a>
      </p>
      ${renderLinkValidityHint(linkExpiresAt)}
      <p style="color:#666;font-size:13px">
        If the button doesn't work, copy this link into your browser:<br>
        <span style="word-break: break-all">${actionUrl}</span>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="color:#999;font-size:12px">
        We'll remind you again 3 days before the trial ends. If you have questions, just reply to this email.
      </p>
    </div>
  `;
  return loopar.mail.send({ to, subject, html });
}

/**
 * Portal-access email — for already-active subscriptions. The customer is
 * paying just fine; they just lost the original Portal link and need it back
 * to update payment, download invoices or cancel.
 */
async function sendPortalAccessEmail({ to, tenantName, planName, actionUrl, linkExpiresAt, setup }) {
  const subject = `Your ${tenantName} billing portal`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
      <h2 style="margin: 0 0 16px 0;">Manage your subscription</h2>
      <p>Here's a fresh link to your billing portal for <strong>${tenantName}</strong> (${planName}).</p>
      <p>From the portal you can update your payment method, download invoices, or cancel your subscription anytime.</p>
      ${renderSetupFeeBlock(setup)}
      <p style="margin: 28px 0;">
        <a href="${actionUrl}"
           style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Open billing portal
        </a>
      </p>
      ${renderLinkValidityHint(linkExpiresAt)}
      <p style="color:#666;font-size:13px">
        If the button doesn't work, copy this link into your browser:<br>
        <span style="word-break: break-all">${actionUrl}</span>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="color:#999;font-size:12px">
        If you need a fresh link after the date above, just reply and we'll send another.
      </p>
    </div>
  `;
  return loopar.mail.send({ to, subject, html });
}

/**
 * Scheduled-subscription start email — sent when the operator opens a Sub
 * with a future billing anchor for an existing tenant. The first charge
 * hasn't happened yet; the customer needs to add payment before then.
 */
async function sendScheduledStartEmail({ to, tenantName, planName, firstChargeAt, actionUrl, linkExpiresAt, setup }) {
  const firstCharge = firstChargeAt
    ? new Date(firstChargeAt * 1000).toUTCString()
    : 'a scheduled future date';
  const subject = `Your ${tenantName} subscription is scheduled — add payment to activate`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
      <h2 style="margin: 0 0 16px 0;">Your subscription is scheduled</h2>
      <p>Your subscription to <strong>${planName}</strong> for <strong>${tenantName}</strong> is scheduled to start on <strong>${firstCharge}</strong>.</p>
      <p>Add a payment method now so Stripe can charge you on that date — without one, the subscription won't activate.</p>
      ${renderSetupFeeBlock(setup)}
      <p style="margin: 28px 0;">
        <a href="${actionUrl}"
           style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Add payment method
        </a>
      </p>
      ${renderLinkValidityHint(linkExpiresAt)}
      <p style="color:#666;font-size:13px">
        If the button doesn't work, copy this link into your browser:<br>
        <span style="word-break: break-all">${actionUrl}</span>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="color:#999;font-size:12px">
        From the same link you can update your card, view invoices and cancel anytime. If you have questions, just reply to this email.
      </p>
    </div>
  `;
  return loopar.mail.send({ to, subject, html });
}

/**
 * Small "Valid until <date>" hint shown right below the CTA button. Helps
 * customers who archive emails know whether the link is still likely to work
 * before they click. Renders nothing if no expiry was supplied.
 */
function renderLinkValidityHint(linkExpiresAt) {
  if (!linkExpiresAt) return '';
  let pretty;
  try { pretty = new Date(linkExpiresAt).toUTCString(); }
  catch (_) { return ''; }
  return `
    <p style="color:#888;font-size:12px;margin:-12px 0 18px 0;">
      Link valid until <strong>${pretty}</strong>. After that, reply and we'll send a fresh one.
    </p>
  `;
}
