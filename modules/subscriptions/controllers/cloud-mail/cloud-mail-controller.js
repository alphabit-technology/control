'use strict';

import { BaseController, loopar } from 'loopar';
import crypto from 'node:crypto';

/**
 * Cloud Mail gateway — lets a cloud-provisioned tenant send transactional
 * email through the control plane's SMTP when it has no Email Settings of
 * its own (the common case right after provisioning).
 *
 *   POST /api/cloud-mail/send
 *   headers:
 *     X-Loopar-Tenant-Secret: <verifier_token> (the tenant's CLOUD_VERIFIER_TOKEN)
 *   body: { tenant_name, to, subject, html }
 *
 *   200 { success:true } — queued/sent
 *   401 { success:false, reason } — bad/missing secret
 *   4xx/5xx — validation / transport error
 *
 * Trust model: the tenant proves it is who it claims by presenting the
 * per-tenant `verifier_token` we stored in `Provisioned Tenant` at
 * provisioning time. Constant-time compare. A stolen token only lets an
 * attacker send email AS that one tenant (and can be revoked by rotating the
 * row), not as any other.
 *
 * Intentionally a thin relay — the tenant composes the full email (subject
 * + html). We don't template here; the tenant owns its copy. A per-tenant
 * rate limit and a TTL on gateway usage are obvious hardening steps once we
 * have more than a handful of cloud tenants in flight.
 */
export default class CloudMailController extends BaseController {
  async publicActionSend() {
    const data = this.data || {};
    const tenantName = String(data.tenant_name || '').trim();
    const to = data.to;
    const subject = String(data.subject || '').trim();
    const html = data.html;
    const verifierToken = String(this.req?.headers?.['x-loopar-tenant-secret'] || '').trim();

    if (!tenantName) return { status: 400, success: false, reason: 'missing_tenant_name' };
    if (!to) return { status: 400, success: false, reason: 'missing_to' };
    if (!subject) return { status: 400, success: false, reason: 'missing_subject' };
    if (!html) return { status: 400, success: false, reason: 'missing_html' };
    if (!verifierToken) return { status: 401, success: false, reason: 'missing_secret' };

    // Look up the per-tenant secret.
    const pt = await loopar.getDocument('Provisioned Tenant', tenantName, null, { ifNotFound: null });
    if (!pt?.name || !pt.verifier_token) {
      return { status: 401, success: false, reason: 'tenant_not_registered' };
    }

    // Constant-time compare.
    const expected = String(pt.verifier_token);
    const provided = verifierToken;
    if (expected.length !== provided.length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
      return { status: 401, success: false, reason: 'verifier_mismatch' };
    }

    // Send via the control plane's configured Email Settings.
    try {
      await loopar.mail.send({ to, subject, html });
      return { status: 200, success: true };
    } catch (err) {
      console.error('[cloud-mail] send failed for', tenantName, '-', err.message);
      return { status: 502, success: false, reason: 'send_failed', message: err.message };
    }
  }
}
