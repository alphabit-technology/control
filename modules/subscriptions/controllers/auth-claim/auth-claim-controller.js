'use strict';

import { BaseController } from 'loopar';
import { verifyAndConsumeClaim } from '../../claim-issuer.js';

/**
 * Server-to-server verifier for the cloud "first login" magic-link.
 *
 *   POST /api/auth-claim/verify
 *   headers:
 *     X-Loopar-Tenant-Secret: <verifier_token> (the per-tenant shared secret
 *                                                 the control plane wrote into
 *                                                 the new tenant's .env as
 *                                                 CLOUD_VERIFIER_TOKEN)
 *     X-Loopar-Tenant-Id: <tenant_id> (optional, defense-in-depth)
 *   body: { token: "<jwt>" }
 *
 *   200 { valid:true, email, tenant } — caller may log the user in
 *   200 { valid:false, reason: "..." } — caller must show "invalid link"
 *
 * The endpoint is "public" in the Loopar sense (no Loopar session) because
 * the calling tenant has no Loopar session in the control plane. Auth is
 * established by the shared verifier_token header — a stolen JWT alone is
 * useless without it.
 */
export default class AuthClaimController extends BaseController {
  async publicActionVerify() {
    const token = String(this.data?.token || this.body?.token || '').trim();
    const verifierToken = String(this.req?.headers?.['x-loopar-tenant-secret'] || '').trim();
    const tenantHint = String(this.req?.headers?.['x-loopar-tenant-id'] || '').trim() || null;

    if (!token) {
      return { status: 400, success: false, valid: false, reason: 'missing_token' };
    }
    if (!verifierToken) {
      return { status: 401, success: false, valid: false, reason: 'missing_verifier' };
    }

    // Best-effort caller IP. Trust x-forwarded-for only if Loopar is behind
    // a proxy (Caddy in our case). Cap length to avoid garbage in the audit
    // column.
    const xff = String(this.req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = xff || this.req?.socket?.remoteAddress || null;

    const result = await verifyAndConsumeClaim(token, verifierToken, { ip, tenantHint });

    if (!result.valid) {
      // 200 with `valid:false` — this is a "the answer is no" response, not
      // a transport error. Keeps the tenant's client code simple.
      return { status: 200, success: true, valid: false, reason: result.reason };
    }

    return {
      status: 200,
      success: true,
      valid: true,
      email: result.email,
      tenant: result.tenant,
    };
  }
}
