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
import { Loader2, Copy, Check, MailCheck } from "lucide-react";

/**
 * "Resend activation email" modal — for Subscriptions whose customer never
 * received (or lost) the original activation email. Generates a fresh
 * Customer Portal session and re-sends the email automatically.
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
    } catch (_) { /* clipboard may be blocked */ }
  };
  return (
    <Button variant="outline" size="sm" type="button" onClick={onCopy}>
      {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
      {copied ? "Copied!" : "Copy"}
    </Button>
  );
}

export default function ResendActivationModal({ open, onClose }) {
  const [items, setItems] = useState([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError] = useState(null);

  const [subscriptionName, setSubscriptionName] = useState("");
  const [submitting, setSubmitting]             = useState(false);
  const [submitError, setSubmitError]           = useState(null);
  const [result, setResult]                     = useState(null);

  const reset = () => {
    setSubscriptionName(""); setSubmitError(null); setResult(null);
  };
  const handleClose = () => { reset(); onClose?.(); };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingMeta(true);
    setMetaError(null);
    setSubmitError(null);
    setResult(null);

    fetch("/api/Signup/listResendableSubscriptions", {
      credentials: "include",
      headers: { "X-CSRF-Token": getCsrfToken() },
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data?.success) setItems(data.subscriptions || []);
        else setMetaError(data?.message || "Could not load subscriptions");
      })
      .catch(err => { if (!cancelled) setMetaError(err.message); })
      .finally(() => { if (!cancelled) setLoadingMeta(false); });

    return () => { cancelled = true; };
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch("/api/Signup/resendActivationEmail", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken(),
        },
        body: JSON.stringify({ subscription_name: subscriptionName }),
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

  if (open && result) {
    return (
      <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MailCheck className="h-5 w-5 text-green-600" />
              Email sent
            </DialogTitle>
            <DialogDescription>{result.message}</DialogDescription>
          </DialogHeader>
          {result.portal_url && (
            <div className="space-y-1 py-2">
              <label className="text-sm font-medium">Customer Portal URL (in case you want to forward it manually):</label>
              <div className="flex gap-2">
                <Input readOnly value={result.portal_url} className="font-mono text-xs" />
                <CopyButton value={result.portal_url} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={handleClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : handleClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resend activation email</DialogTitle>
          <DialogDescription>
            Pick a Subscription whose customer needs a fresh Customer Portal link.
            We'll generate a new session and email it automatically.
          </DialogDescription>
        </DialogHeader>

        {loadingMeta ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : metaError ? (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{metaError}</div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Subscription</label>
              <select
                className="w-full p-2 border border-border bg-background rounded-md text-sm"
                value={subscriptionName}
                onChange={(e) => setSubscriptionName(e.target.value)}
                required
                disabled={submitting}
              >
                <option value="">— Select a subscription —</option>
                {items.map(it => (
                  <option key={it.name} value={it.name}>
                    {it.tenant_name} · {it.plan_name || '—'} · {it.status} · {it.email || '—'}
                  </option>
                ))}
              </select>
              {!items.length && (
                <p className="text-xs text-muted-foreground">
                  No subscriptions waiting for activation. Only Subs in <code>incomplete</code>,
                  <code> trialing</code>, <code>past_due</code> or <code>pending</code> appear here.
                </p>
              )}
            </div>

            {submitError && (
              <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{submitError}</div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || !subscriptionName}>
                {submitting ? (
                  <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Sending…</>
                ) : (
                  "Resend email"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
