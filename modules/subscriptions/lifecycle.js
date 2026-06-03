'use strict';

import { loopar } from 'loopar';
import { promisify } from 'util';
import pm2 from 'pm2';
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

const pm2Connect = promisify(pm2.connect.bind(pm2));
const pm2Disconnect = promisify(pm2.disconnect.bind(pm2));
const pm2Delete = promisify(pm2.delete.bind(pm2));

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
    const sitePath = path.join(process.cwd(), 'sites', row.tenant_name);

    // Final pm2 delete in case a stopped process is still registered.
    try {
      await pm2Connect();
      try { await pm2Delete(row.tenant_name); } catch (_) { /* gone already */ }
      await pm2Disconnect().catch(() => {});
    } catch (_) { /* connect failed — nothing to clean from pm2 */ }

    if (fs.existsSync(sitePath)) {
      try {
        fs.rmSync(sitePath, { recursive: true, force: true });
        console.log(`[lifecycle/cleanup] removed sites/${row.tenant_name}`);
        removed++;
      } catch (err) {
        console.error(`[lifecycle/cleanup] rm ${sitePath}:`, err.message);
      }
    }

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
