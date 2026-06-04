'use strict';

import { BaseController, loopar, tenant } from 'loopar';
import Stripe from 'stripe';
import { provisionTenant } from '../../../subscriptions/provisioning.js';

/**
 * Hydrate a Tenant Manager doc for the given tenant name, or null if it
 * doesn't exist. Used by handlers to call `start()` / `stop()` /
 * `removeDomain()` — the same methods the desk's Tenant Manager buttons use.
 */
async function getTenantDoc(tenantName) {
  return await loopar.getDocument('Tenant Manager', tenantName, null, { ifNotFound: null });
}

/**
 * Stripe webhook receiver — public, unauthenticated: POST /stripe-webhook/receive
 *
 * Verifies the Stripe signature against the raw request body (stashed on
 * req.rawBody by the express.json `verify` hook in core/server/server.js),
 * stores the event for idempotency, and dispatches to a per-event handler.
 * Responds 200 once the event is recorded; handler errors are logged but
 * never bubble out, so Stripe doesn't retry an event we already accepted.
 */
export default class StripeWebhookController extends BaseController {
  async publicActionReceive() {
    // Secret key + webhook signing secret live on the single `Stripe Account`
    // doc as password fields: the server-side getter returns the real values,
    // while the desk UI only ever sees the masked placeholder.
    const account = await loopar.getDocument('Stripe Account');
    const secretKey = account?.secret_key;
    const webhookSecret = account?.webhook_secret;

    if (!secretKey || !webhookSecret) {
      console.error('[stripe-webhook] Stripe Account is not configured (secret_key / webhook_secret missing)');
      return { status: 500, success: false, message: 'Stripe is not configured' };
    }

    const signature = this.req?.headers?.['stripe-signature'];
    const rawBody = this.req?.rawBody;

    if (!signature || !rawBody) {
      return { status: 400, success: false, message: 'Missing Stripe signature or raw body' };
    }

    let event;
    try {
      const stripe = Stripe(secretKey);
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error('[stripe-webhook] signature verification failed:', err.message);
      return { status: 400, success: false, message: 'Signature verification failed' };
    }

    // Idempotency — Stripe retries deliveries and may send duplicates. We
    // skip ONLY if a previous run already finished processing this event
    // (status === 'processed'). If a row exists with status 'received', it
    // means the event was recorded but dispatch never completed (e.g. an
    // earlier code version didn't handle this event type) — re-dispatch it.
    const existingName = await loopar.db.getValue(
      'Webhook Event', 'name', event.id, { ifNotFound: null }
    );
    let prior = null;
    
    if (existingName) {
      prior = await loopar.getDocument('Webhook Event', event.id);

      if (prior?.status === 'processed') {
        return { status: 200, success: true, message: 'duplicate ignored' };
      }
    }

    // Record the event first (status: received). If we already had a row
    // from a prior unfinished run, leave it in place — _markProcessed will
    // flip it to 'processed' once dispatch finishes.
    
    if (!prior) {
      try {
        const webhookEvent = await loopar.newDocument('Webhook Event');
        webhookEvent.name = event.id;
        webhookEvent.stripe_event_id = event.id;
        webhookEvent.type = event.type;
        webhookEvent.status = 'received';
        webhookEvent.payload = JSON.stringify(event);
        await webhookEvent.save();
      } catch (err) {
        console.error('[stripe-webhook] failed to record event:', err.message);
        return { status: 500, success: false, message: 'Failed to record event' };
      }
    }

    // Dispatch — per event type. Best-effort: dispatch errors are logged but
    // we still return 200 to Stripe (the event is recorded; we don't want
    // Stripe to retry against a successfully-stored event).
    try {
      await this.dispatch(event);
    } catch (err) {
      console.error('[stripe-webhook] dispatch failed for', event.id, '-', err.message);
    }

    return { status: 200, success: true, received: true, type: event.type };
  }

  async dispatch(event) {
    switch (event.type) {
      case 'checkout.session.completed':
        return this.handleCheckoutCompleted(event);
      case 'customer.subscription.updated':
        return this.handleSubscriptionUpdated(event);
      case 'customer.subscription.deleted':
        return this.handleSubscriptionDeleted(event);
      case 'customer.subscription.trial_will_end':
        return this.handleTrialWillEnd(event);
      case 'invoice.payment_succeeded':
        return this.handleInvoicePaymentSucceeded(event);
      case 'invoice.payment_failed':
        return this.handleInvoicePaymentFailed(event);
    }
  }

  /**
   * Mark the WebhookEvent we already stored as processed. Idempotent — safe
   * to call even if it was already marked, or if it doesn't exist yet.
   */
  async _markProcessed(eventId) {
    try {
      const we = await loopar.getDocument('Webhook Event', eventId);
      if (we?.name && we.status !== 'processed') {
        we.status = 'processed';
        we.processed_at = new Date().toISOString();
        await we.save({ validate: false });
      }
    } catch (_) { /* non-fatal */ }
  }

  /**
   * customer.subscription.updated — the catch-all for status transitions
   * (active → past_due → active) and plan changes. We react on `past_due` /
   * `unpaid` (suspend) and `active` / `trialing` (resume), keeping the
   * tenant runtime aligned with what Stripe knows.
   */
  async handleSubscriptionUpdated(event) {
    const sub = event.data?.object;
    if (!sub?.id) return;

    const tenantName = sub?.metadata?.tenant_name;
    if (!tenantName) {
      console.warn(`[stripe-webhook] subscription.updated for ${sub.id}: no tenant_name in metadata — skipping`);
      await this._markProcessed(event.id);
      return;
    }

    const doc = await getTenantDoc(tenantName);
    if (!doc) {
      console.warn(`[stripe-webhook] subscription.updated: could not hydrate ${tenantName}`);
      await this._markProcessed(event.id);
      return;
    }

    if (['past_due', 'unpaid'].includes(sub.status)) {
      try {
        await doc.stop();
        await doc.removeDomain(doc.domain);
        console.log(`[stripe-webhook] suspended ${tenantName} (${sub.status})`);
      } catch (err) {
        console.error('[stripe-webhook] suspend failed:', err.message);
      }
    }

    if (['active', 'trialing'].includes(sub.status)) {
      // Idempotent: Tenant Manager.start re-registers Caddy and ensures
      // PM2 is up. Safe on an already-running tenant.
      try {
        await doc.start();
        console.log(`[stripe-webhook] active/trialing ${tenantName} — ensured running`);
      } catch (err) {
        console.error('[stripe-webhook] resume failed:', err.message);
      }
    }

    await this._markProcessed(event.id);
  }

  /**
   * customer.subscription.deleted — final cancellation (Customer Portal
   * "Cancel subscription", trial that ended without a card, or end of the
   * unpaid retry window). Suspend the tenant immediately; the filesystem
   * is preserved for the operator to inspect or revive on their own — the
   * cleanup endpoint is the only path that actually deletes anything.
   */
  async handleSubscriptionDeleted(event) {
    const sub = event.data?.object;
    if (!sub?.id) return;
    const tenantName = sub?.metadata?.tenant_name;
    if (!tenantName) {
      console.warn(`[stripe-webhook] subscription.deleted ${sub.id}: no tenant_name in metadata`);
      await this._markProcessed(event.id);
      return;
    }
    const doc = await getTenantDoc(tenantName);
    if (!doc) {
      console.warn(`[stripe-webhook] subscription.deleted: tenant "${tenantName}" already gone`);
      await this._markProcessed(event.id);
      return;
    }
    try {
      await doc.stop();
      await doc.removeDomain(doc.domain);
      console.log(`[stripe-webhook] canceled tenant ${tenantName} (Stripe sub ${sub.id})`);
    } catch (err) {
      console.error('[stripe-webhook] cancel suspend failed:', err.message);
    }
    await this._markProcessed(event.id);
  }

  /**
   * customer.subscription.trial_will_end — Stripe fires this ~3 days before
   * the trial ends. We send a reminder email with the Customer Portal link
   * so the customer can add a payment method before the trial converts to
   * an unpaid Sub (and eventually deletes the tenant per the grace period).
   */
  async handleTrialWillEnd(event) {
    const sub = event.data?.object;
    if (!sub?.id) return;

    const tenantName = sub?.metadata?.tenant_name;
    const planName   = sub?.metadata?.plan_name || 'your plan';
    const customerId = sub?.customer;

    if (!tenantName || !customerId) {
      console.warn('[stripe-webhook] trial_will_end: missing tenant_name or customer in metadata');
      await this._markProcessed(event.id);
      return;
    }

    // Fetch customer email + create portal session — all from Stripe.
    const account = await loopar.getDocument('Stripe Account');
    const stripeClient = Stripe(account?.secret_key);
    let customerEmail = null;
    let portalUrl = null;
    try {
      const stripeCustomer = await stripeClient.customers.retrieve(customerId);
      customerEmail = stripeCustomer?.email;
    } catch (err) {
      console.warn('[stripe-webhook] trial_will_end: could not fetch customer:', err.message);
    }
    if (!customerEmail) {
      await this._markProcessed(event.id);
      return;
    }

    try {
      // Tenant exists by the time we hit trial_will_end, so the no-override
      // form is enough — tenantUrl reads its own DOMAIN/PORT and picks
      // http://...:port for .localhost vs https://... for real domains.
      const returnUrl = tenant.tenantUrl(tenantName);
      const portalSession = await stripeClient.billingPortal.sessions.create({
        customer:   customerId,
        return_url: returnUrl,
      });
      portalUrl = portalSession.url;
    } catch (err) {
      console.warn('[stripe-webhook] trial_will_end: portal session failed:', err.message);
    }

    try {
      await sendTrialWillEndEmail({
        to:       customerEmail,
        tenantName,
        planName,
        trialEnd: sub.trial_end,
        portalUrl,
      });
    } catch (err) {
      console.error('[stripe-webhook] trial_will_end email failed:', err.message);
    }
    await this._markProcessed(event.id);
  }

  /**
   * invoice.payment_succeeded — most common case is the recurring monthly
   * charge succeeded. Sync the new period_end and clear any suspended flag
   * (defense in depth: subscription.updated should also fire, but redundant
   * is fine for idempotent updates).
   */
  async handleInvoicePaymentSucceeded(event) {
    const invoice = event.data?.object;
    const stripeSubId = invoice?.subscription;
    if (!stripeSubId) {
      await this._markProcessed(event.id);
      return;
    }

    // Fetch the Sub to read its metadata.tenant_name (invoices don't carry
    // the subscription's metadata directly).
    const account = await loopar.getDocument('Stripe Account');
    const stripeClient = Stripe(account?.secret_key);
    let tenantName = null;
    try {
      const stripeSub = await stripeClient.subscriptions.retrieve(stripeSubId);
      tenantName = stripeSub?.metadata?.tenant_name;
    } catch (err) {
      console.warn('[stripe-webhook] payment_succeeded: could not fetch Sub:', err.message);
    }

    if (!tenantName) {
      await this._markProcessed(event.id);
      return;
    }

    const doc = await getTenantDoc(tenantName);
    if (!doc) {
      await this._markProcessed(event.id);
      return;
    }

    // Defense in depth — ensure the tenant is running after a successful
    // payment (covers the case where we missed the .updated event that
    // would have resumed it).
    try {
      await doc.start();
    } catch (err) {
      console.error('[stripe-webhook] resume failed:', err.message);
    }
    await this._markProcessed(event.id);
  }

  /**
   * invoice.payment_failed — Stripe retries on its own (3-4 attempts over
   * ~3 weeks). We don't react to the first failure to avoid suspending
   * tenants on transient card hiccups; the actual suspension fires from
   * subscription.updated → past_due once Stripe gives up. This handler
   * just logs so a failed retry is visible.
   */
  async handleInvoicePaymentFailed(event) {
    const invoice = event.data?.object;
    console.log(
      `[stripe-webhook] payment_failed invoice=${invoice?.id} sub=${invoice?.subscription} ` +
      `attempt=${invoice?.attempt_count} — Stripe will retry; suspension waits for past_due`
    );
    await this._markProcessed(event.id);
  }

  /**
   * checkout.session.completed — the customer finished Stripe Checkout.
   * Look up the local Subscription we created at signup (linked via
   * metadata.subscription_id), wire it to the Stripe customer/subscription
   * ids, and flip the status. For cloud purchases, fire-and-forget the
   * provisioning so Stripe gets its 200 back fast while we spin up the
   * tenant in the background.
   */
  async handleCheckoutCompleted(event) {
    const session = event.data?.object;
    const subId = session?.metadata?.subscription_id;
    if (!subId) {
      console.warn('[stripe-webhook] checkout.session.completed without subscription_id metadata — skipping');
      return;
    }

    const subscription = await loopar.getDocument('Subscription', subId);
    if (!subscription || !subscription.name) {
      console.warn(`[stripe-webhook] Subscription "${subId}" not found — skipping`);
      return;
    }

    // payment_status === 'no_payment_required' covers the "trial without
    // immediate charge" case; 'paid' is the normal case. Either way we own
    // a Subscription on Stripe now.
    const trialing = session.payment_status === 'no_payment_required';

    if (session.subscription) subscription.stripe_subscription_id = session.subscription;
    subscription.status = trialing ? 'trialing' : 'active';

    // Safety net for the fire-and-forget provisioning below: if the control
    // plane crashes between this ACK and provisionTenant clearing the field,
    // the retry sweep (cron + boot hook) picks it up after 2 minutes. The
    // happy path clears `provisioning_retry_after` inside provisionTenant.
    subscription.provisioning_retry_after = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    await subscription.save();

    // Link Stripe customer id back to the local Customer row.
    if (session.customer && subscription.customer) {
      const customer = await loopar.getDocument('Customer', subscription.customer);
      if (customer?.name && !customer.stripe_customer_id) {
        customer.stripe_customer_id = session.customer;
        await customer.save();
      }
    }

    await this._markProcessed(event.id);

    // Cloud purchases trigger the actual tenant provisioning. We don't
    // await it — Stripe wants a fast 200, and the Caddy + PM2 spin-up takes
    // several seconds. The /success page tracks progress over realtime
    // (`provisioning-progress` channel) with a poll fallback against
    // /api/signup/status. Errors are surfaced from inside provisionTenant.
    const category = String(session?.metadata?.category || '').toLowerCase();
    const isCloud = category === 'cloud' || !!session?.metadata?.tenant_name;
    if (isCloud) {
      provisionTenant(subId).catch(err => {
        console.error('[stripe-webhook] provisionTenant threw for', subId, '-', err.message);
      });
    }
  }
}

/**
 * Email sent ~3 days before a trial ends — invites the customer to add a
 * payment method via the Customer Portal. Fired from
 * `handleTrialWillEnd` (customer.subscription.trial_will_end).
 */
async function sendTrialWillEndEmail({ to, tenantName, planName, trialEnd, portalUrl }) {
  const endDate = trialEnd ? new Date(trialEnd * 1000).toUTCString() : 'soon';
  const subject = `Your ${tenantName} trial ends ${trialEnd ? 'on ' + endDate : 'soon'} — add payment to continue`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
      <h2 style="margin: 0 0 16px 0;">Your trial is almost over</h2>
      <p>Your <strong>${planName || 'Loopar Cloud'}</strong> trial for <strong>${tenantName}</strong> ends <strong>${endDate}</strong>.</p>
      <p>Add a payment method now to continue without interruption. If you don't, your workspace will be paused.</p>
      ${portalUrl ? `
        <p style="margin: 28px 0;">
          <a href="${portalUrl}"
             style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
            Add payment method
          </a>
        </p>
        <p style="color:#666;font-size:13px">
          Or copy this link: <span style="word-break: break-all">${portalUrl}</span>
        </p>
      ` : `
        <p style="color:#666;font-size:13px">Reply to this email and we'll help you add a payment method.</p>
      `}
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="color:#999;font-size:12px">
        If you've already added a payment method, you can ignore this message.
      </p>
    </div>
  `;
  return loopar.mail.send({ to, subject, html });
}
