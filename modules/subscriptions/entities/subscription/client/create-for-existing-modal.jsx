import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@cn/components/ui/dialog";
import { Button } from "@cn/components/ui/button";
import { Input } from "@cn/components/ui/input";
import { cn } from "@cn/lib/utils";
import { Loader2, Copy, Check } from "lucide-react";

/**
 * "New Subscription for existing tenant" modal.
 *
 * Used by the Subscription list toolbar. Lets the operator associate a Stripe
 * Subscription with a workspace that ALREADY exists (no provisioning).
 *
 * Three modes:
 *   - trial     → Stripe Sub created in `trialing`, customer receives email
 *                 with Customer Portal link to add payment.
 *   - scheduled → Stripe Sub with billing_cycle_anchor. First charge on the
 *                 chosen date. Operator gets a Customer Portal URL to send.
 *   - checkout  → Stripe Checkout Session URL for the operator to forward.
 *
 * The form auto-populates the tenant selector (only tenants without an
 * active/trialing Sub appear) and the plan selector (active recurring Stripe
 * prices with `metadata.category=cloud`).
 */

function getCsrfToken() {
  if (typeof document === "undefined") return "";
  return document.cookie.match(/csrf-token=([^;]+)/)?.[1] || "";
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) { /* ignore — clipboard may be blocked */ }
  };
  return (
    <Button variant="outline" size="sm" type="button" onClick={onCopy}>
      {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
      {copied ? "Copied!" : "Copy"}
    </Button>
  );
}

function defaultAnchorISO() {
  // First day of NEXT month, in YYYY-MM-DD (the format <input type="date"> expects).
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

export default function CreateForExistingModal({ open, onClose }) {
  const [tenants, setTenants] = useState([]);
  const [plans, setPlans]     = useState([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError]     = useState(null);

  const [tenantName, setTenantName]       = useState("");
  const [email, setEmail]                 = useState("");
  const [priceId, setPriceId]             = useState("");
  const [mode, setMode]                   = useState("trial");
  const [trialDays, setTrialDays]         = useState(30);
  const [billingAnchor, setBillingAnchor] = useState(defaultAnchorISO());
  const [setupFee, setSetupFee]           = useState("");      // dollars, optional
  const [setupFeeLabel, setSetupFeeLabel] = useState("Setup fee");
  const [setupInstallments, setSetupInstallments] = useState(""); // "" or 1 = single, 2..12 = installments

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);

  // Reset everything when the dialog is dismissed.
  const reset = () => {
    setTenantName(""); setEmail(""); setPriceId(""); setMode("trial");
    setTrialDays(30); setBillingAnchor(defaultAnchorISO());
    setSetupFee(""); setSetupFeeLabel("Setup fee"); setSetupInstallments("");
    setSubmitError(null); setResult(null);
  };
  const handleClose = () => { reset(); onClose?.(); };

  // Load tenants + plans whenever the dialog is opened (in case the operator
  // adds new ones between sessions, etc.).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingMeta(true);
    setMetaError(null);
    setSubmitError(null);
    setResult(null);

    const csrf = getCsrfToken();
    Promise.all([
      fetch("/api/Signup/listAvailableTenants", {
        credentials: "include",
        headers: { "X-CSRF-Token": csrf },
      }).then(r => r.json()),
      fetch("/api/signup/plans?category=cloud", {
        credentials: "include",
      }).then(r => r.json()),
    ])
      .then(([tenantsResp, plansResp]) => {
        if (cancelled) return;
        if (tenantsResp?.success) setTenants(tenantsResp.tenants || []);
        else setMetaError(tenantsResp?.message || "Could not load tenants");
        if (plansResp?.success) setPlans(plansResp.plans || []);
      })
      .catch(err => { if (!cancelled) setMetaError(err.message); })
      .finally(() => { if (!cancelled) setLoadingMeta(false); });

    return () => { cancelled = true; };
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);

    const body = { tenant_name: tenantName, price_id: priceId, email, mode };
    if (mode === "trial") body.trial_days = parseInt(trialDays, 10) || 30;
    if (mode === "scheduled" && billingAnchor) body.billing_anchor = billingAnchor;

    // Optional setup fee. Convert dollars → cents.
    const feeDollars = Number(setupFee);
    if (Number.isFinite(feeDollars) && feeDollars > 0) {
      body.setup_fee_cents = Math.round(feeDollars * 100);
      body.setup_fee_label = setupFeeLabel || "Setup fee";

      // Installments only apply to trial/scheduled — backend rejects them
      // for checkout. The select reflects this so we don't bother sending.
      const installments = parseInt(setupInstallments, 10);
      if (Number.isFinite(installments) && installments > 1 && mode !== "checkout") {
        body.setup_fee_installments = Math.min(12, installments);
      }
    }

    try {
      const r = await fetch("/api/Signup/createForExisting", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data?.success) setResult(data);
      else setSubmitError(data?.message || `Request failed (${r.status})`);
    } catch (err) {
      setSubmitError("Network error: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ----- result screen ---------------------------------------------------
  if (open && result) {
    const successTitle =
      result.stripe_status === "trialing" ? "Trial started" :
      result.checkout_url ? "Checkout link ready" :
      "Subscription scheduled";

    return (
      <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{successTitle}</DialogTitle>
            <DialogDescription>{result.message}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="text-sm">
              <span className="text-muted-foreground">Subscription:</span>{" "}
              <code className="text-xs">{result.subscription_id}</code>
            </div>
            {result.stripe_subscription_id && (
              <div className="text-sm">
                <span className="text-muted-foreground">Stripe:</span>{" "}
                <code className="text-xs">{result.stripe_subscription_id}</code>
              </div>
            )}
            {result.trial_end && (
              <div className="text-sm">
                <span className="text-muted-foreground">Trial ends:</span>{" "}
                {new Date(result.trial_end * 1000).toUTCString()}
              </div>
            )}
            {result.checkout_url && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Checkout URL — send to customer:</label>
                <div className="flex gap-2">
                  <Input readOnly value={result.checkout_url} className="font-mono text-xs" />
                  <CopyButton value={result.checkout_url} />
                </div>
              </div>
            )}
            {result.portal_url && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Customer Portal URL:</label>
                <div className="flex gap-2">
                  <Input readOnly value={result.portal_url} className="font-mono text-xs" />
                  <CopyButton value={result.portal_url} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Customer can add/update payment method, view invoices and cancel from here.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" onClick={handleClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ----- form screen -----------------------------------------------------
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Subscription for existing tenant</DialogTitle>
          <DialogDescription>
            Associate a Stripe Subscription with a workspace you already created.
          </DialogDescription>
        </DialogHeader>

        {loadingMeta ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : metaError ? (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">
            {metaError}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Tenant</label>
              <select
                className="w-full p-2 border border-border bg-background rounded-md text-sm"
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                required
                disabled={submitting}
              >
                <option value="">— Select a workspace —</option>
                {tenants.map(t => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.domain}{t.port ? `:${t.port}` : ""})
                  </option>
                ))}
              </select>
              {!tenants.length && (
                <p className="text-xs text-muted-foreground">
                  No available tenants. All existing ones already have an active subscription, or none exist yet.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Customer email</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={submitting}
                placeholder="customer@example.com"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Plan</label>
              <select
                className="w-full p-2 border border-border bg-background rounded-md text-sm"
                value={priceId}
                onChange={(e) => setPriceId(e.target.value)}
                required
                disabled={submitting}
              >
                <option value="">— Select a plan —</option>
                {plans.map(p => (
                  <option key={p.price_id} value={p.price_id}>
                    {p.name} — {p.amount != null
                      ? `${(p.currency || "USD").toUpperCase()} ${(p.amount / 100).toFixed(2)}/${p.interval || "month"}`
                      : "Custom"}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">
                Setup fee (USD) <span className="text-muted-foreground font-normal">— optional</span>
              </label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={setupFee}
                  onChange={(e) => setSetupFee(e.target.value)}
                  placeholder="0.00"
                  disabled={submitting}
                  className="max-w-[120px]"
                />
                <Input
                  type="text"
                  value={setupFeeLabel}
                  onChange={(e) => setSetupFeeLabel(e.target.value)}
                  placeholder="Setup fee"
                  disabled={submitting || !setupFee || Number(setupFee) <= 0}
                  maxLength={80}
                />
              </div>
              {Number(setupFee) > 0 && mode !== "checkout" && (
                <div className="pt-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Pay setup in (months)
                  </label>
                  <Input
                    type="number"
                    min="1"
                    max="12"
                    step="1"
                    value={setupInstallments}
                    onChange={(e) => setSetupInstallments(e.target.value)}
                    placeholder="1 (single payment)"
                    disabled={submitting}
                    className="max-w-[160px] mt-1"
                  />
                </div>
              )}
              {Number(setupFee) > 0 && (() => {
                const planPrice = plans.find(p => p.price_id === priceId);
                const planAmount = planPrice?.amount;
                const planCurrency = (planPrice?.currency || "USD").toUpperCase();
                const interval = planPrice?.interval || "month";
                const setupAmount = Number(setupFee);
                const installments = parseInt(setupInstallments, 10);
                const isInstallments =
                  Number.isFinite(installments) && installments > 1 && mode !== "checkout";
                const perInstallment = isInstallments ? setupAmount / installments : null;
                const planDollars = planAmount != null ? planAmount / 100 : null;

                if (isInstallments && planDollars != null) {
                  return (
                    <p className="text-xs text-muted-foreground">
                      Setup paid as <strong>{planCurrency} {perInstallment.toFixed(2)}</strong>/month
                      {" "}× <strong>{installments}</strong> (auto-cancels).
                      {" "}Combined first {installments} months:{" "}
                      <strong>{planCurrency} {(perInstallment + planDollars).toFixed(2)}/month</strong>,
                      {" "}then <strong>{planCurrency} {planDollars.toFixed(2)}/{interval}</strong>.
                    </p>
                  );
                }

                return (
                  <p className="text-xs text-muted-foreground">
                    First invoice: <strong>{planCurrency} {setupAmount.toFixed(2)}</strong> setup
                    {planAmount != null && (
                      <> + <strong>{planCurrency} {(planAmount / 100).toFixed(2)}</strong> plan
                        {" "}= <strong>{planCurrency} {(setupAmount + planAmount / 100).toFixed(2)}</strong></>
                    )}.
                    {planAmount != null && <> Subsequent: <strong>{planCurrency} {(planAmount / 100).toFixed(2)}/{interval}</strong>.</>}
                  </p>
                );
              })()}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Mode</label>
              <div className="space-y-1">
                {[
                  { id: "trial",     label: "Trial",     desc: "Sub trialing without card. Email sent to customer to add payment before trial ends." },
                  { id: "scheduled", label: "Scheduled", desc: "First charge on the chosen date. Customer Portal link to add payment." },
                  { id: "checkout",  label: "Checkout",  desc: "Generate a Stripe Checkout link for you to forward." },
                ].map(m => (
                  <label
                    key={m.id}
                    className={cn(
                      "flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors",
                      mode === m.id ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                    )}
                  >
                    <input
                      type="radio"
                      name="mode"
                      value={m.id}
                      checked={mode === m.id}
                      onChange={() => setMode(m.id)}
                      disabled={submitting}
                      className="mt-1 accent-primary"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-xs text-muted-foreground">{m.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {mode === "trial" && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Trial days</label>
                <Input
                  type="number"
                  min="1"
                  max="365"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  disabled={submitting}
                />
                <p className="text-xs text-muted-foreground">
                  After trial, if no payment method, Stripe cancels the subscription.
                </p>
              </div>
            )}

            {mode === "scheduled" && (
              <div className="space-y-1">
                <label className="text-sm font-medium">First charge date</label>
                <Input
                  type="date"
                  value={billingAnchor}
                  onChange={(e) => setBillingAnchor(e.target.value)}
                  disabled={submitting}
                  min={new Date().toISOString().slice(0, 10)}
                />
              </div>
            )}

            {submitError && (
              <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{submitError}</div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || !tenants.length}>
                {submitting ? (
                  <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Creating…</>
                ) : (
                  "Create Subscription"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
