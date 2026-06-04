'use strict';

import { loopar } from 'loopar';
import fs from 'fs';
import path from 'pathe';

/**
 * Operator-driven cleanup: hard-deletes tenant directories on disk for
 * Subscriptions that have been canceled past the grace period.
 *
 * Suspension and resume of a tenant during the active lifecycle (past_due,
 * unpaid, deleted, payment_succeeded) is handled directly by the webhook
 * handlers using `Tenant Manager` methods — no helpers here. This file
 * exists only for the cron-style cleanup endpoint.
 */

/**
 * Hard-delete tenant directories whose Subscription was canceled more than
 * the grace period ago (Subscription.delete_after <= now). Returns the
 * number of tenants removed. Idempotent and safe to call repeatedly.
 *
 * Intended trigger: a daily OS cron calling
 * `POST /api/Signup/cleanupCanceled`.
 */
export async function cleanupCanceledTenants() {
  const now = new Date().toISOString();

  let rows;
  try {
    rows = await loopar.db.getAll(
      'Subscription',
      ['name', 'tenant_name', 'delete_after'],
      {
        '=':  { status: 'canceled' },
        '<=': { delete_after: now },
      }
    );
  } catch (err) {
    console.error('[lifecycle/cleanup] could not list canceled subs:', err.message);
    return 0;
  }

  let removed = 0;
  for (const row of rows || []) {
    if (!row.tenant_name) continue;

    // Preferred path: hydrate the Tenant Manager doc and let it tear itself
    // down (pm2 stop+delete, caddy unregister, rm sites/<name>/). The doc is
    // null when the tenant entity is gone but the on-disk directory might
    // still exist — fall back to a direct rmSync for that case.
    const doc = await loopar.getDocument(
      'Tenant Manager', row.tenant_name, null, { ifNotFound: null }
    );
    const sitePath = path.join(process.cwd(), 'sites', row.tenant_name);
    let didRemove = false;
    if (doc?.name) {
      try {
        await doc.destroy();
        didRemove = !fs.existsSync(sitePath);
      } catch (err) {
        console.error(`[lifecycle/cleanup] destroy ${row.tenant_name}:`, err.message);
      }
    } else if (fs.existsSync(sitePath)) {
      try {
        fs.rmSync(sitePath, { recursive: true, force: true });
        didRemove = true;
        console.log(`[lifecycle/cleanup] removed sites/${row.tenant_name}`);
      } catch (err) {
        console.error(`[lifecycle/cleanup] rm ${sitePath}:`, err.message);
      }
    }
    if (didRemove) removed++;

    // Stamp the Subscription so we don't keep re-trying once the dir is gone.
    try {
      await loopar.db.updateRow('Subscription', row.name, {
        tenant_provisioned: 0,
        provisioning_step:  'deleted',
      });
    } catch (_) { /* non-fatal */ }
  }

  return removed;
}
