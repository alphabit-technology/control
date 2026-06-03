const RESERVED_NAMES = new Set([
  'www', 'api', 'admin', 'console', 'cloud', 'dev', 'loopar',
  'localhost', 'mail', 'ftp', 'cdn', 'static', 'assets', 'app',
  'auth', 'sites', 'control', 'stripe', 'desk'
]);

const SUBDOMAIN_RE = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PORT_BASE = 3100;
const PORT_MAX = 3999;

const PLANS_CACHE_TTL_MS = 5 * 60 * 1000;

function shapePrice(p) {
  const product = p.product || {};
  return {
    price_id: p.id,
    type: p.type, // 'recurring' | 'one_time'
    name: product.name,
    description: product.description || '',
    amount: p.unit_amount, // may be null when custom_unit_amount is set
    currency: p.currency,
    interval: p.recurring?.interval || null,
    interval_count: p.recurring?.interval_count || 1,
    custom_unit_amount: p.custom_unit_amount
      ? {
          minimum: p.custom_unit_amount.minimum,
          maximum: p.custom_unit_amount.maximum,
          preset:  p.custom_unit_amount.preset,
        }
      : null,
    product_id: product.id,
    product_metadata: product.metadata || {},
    price_metadata: p.metadata || {},
  };
}

function sortByOrder(a, b) {
  const oa = parseInt(a.product_metadata?.order, 10);
  const ob = parseInt(b.product_metadata?.order, 10);
  const va = Number.isFinite(oa) ? oa : 9999;
  const vb = Number.isFinite(ob) ? ob : 9999;
  if (va !== vb) return va - vb;
  return (a.name || '').localeCompare(b.name || '');
}

export {
  RESERVED_NAMES,
  SUBDOMAIN_RE,
  EMAIL_RE,
  PORT_BASE,
  PORT_MAX,
  PLANS_CACHE_TTL_MS,
  shapePrice,
  sortByOrder
}