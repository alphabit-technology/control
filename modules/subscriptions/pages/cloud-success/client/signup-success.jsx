import { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import { useRealtime } from "loopar";
import { Check, Loader2, AlertTriangle, Mail, ExternalLink, X } from "lucide-react";

/**
 * <signup_success> — post-Stripe-Checkout landing page for Loopar Cloud.
 *
 *   /success?session_id=cs_...&subscription_id=sub_pending_...
 *
 * Subscribes to the realtime `provisioning-progress` channel filtered by
 * subscription_id and renders a live progress UI. Falls back to polling
 * `/api/signup/status` every 3s for clients that reconnect late or miss the
 * websocket events (slow networks, locked-down corporate proxies).
 *
 * When the backend reports `ready`, the component shows:
 *   - confirmation that the magic-link email was sent (or a warning if not)
 *   - a direct "Open workspace" button as a shortcut
 *
 * Drop into any Page in the builder; configure title/subtitle from
 * `signup_success.metaFields`.
 */

// Display order for the progress steps. Backend may add new ones over time —
// the renderer falls through gracefully (unknown steps still get a row).
const KNOWN_STEPS = [
  { id: "allocating",        label: "Allocating workspace resources" },
  { id: "writing-env",       label: "Configuring tenant environment" },
  { id: "starting",          label: "Starting tenant server" },
  { id: "installing-loopar", label: "Installing your workspace software" },
  { id: "sending-email",     label: "Sending your sign-in link" },
  { id: "ready",             label: "Your workspace is ready" },
];

const TERMINAL_STEPS = new Set(["ready", "error"]);

function getQueryParam(name) {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function StepRow({ step, state, message }) {
  // state: 'pending' | 'active' | 'done' | 'error' | 'warning'
  const Icon =
    state === "done" ? Check :
    state === "active" ? Loader2 :
    state === "error" ? X :
    state === "warning" ? AlertTriangle :
    null;

  const iconClass = cn(
    "h-4 w-4 shrink-0",
    state === "done"    && "text-green-600",
    state === "active"  && "text-primary animate-spin",
    state === "error"   && "text-red-600",
    state === "warning" && "text-amber-600",
    state === "pending" && "text-muted-foreground"
  );

  return (
    <div className="flex items-start gap-3 py-2">
      <div className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card">
        {Icon ? <Icon className={iconClass} /> : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />}
      </div>
      <div className="flex-1">
        <p className={cn(
          "text-sm",
          state === "pending" ? "text-muted-foreground" : "text-foreground",
          state === "done" && "line-through decoration-muted-foreground/60"
        )}>
          {step.label}
        </p>
        {message && (
          <p className={cn(
            "text-xs mt-0.5",
            state === "error" ? "text-red-600" : "text-muted-foreground"
          )}>{message}</p>
        )}
      </div>
    </div>
  );
}

export default function SignupSuccess({
  title         = "Setting up your workspace",
  subtitle      = "This usually takes 15–30 seconds.",
  ready_title   = "Your workspace is ready",
  ready_subtitle = "We sent a sign-in link to your email — click it from your inbox to enter, or use the shortcut below.",
  support_email = "support@loopar.build",
} = {}) {
  const subscriptionId = useMemo(() => getQueryParam("subscription_id"), []);
  const [currentStep, setCurrentStep] = useState(null);     // 'allocating' | ... | 'ready' | 'error'
  const [errorMessage, setErrorMessage] = useState(null);
  const [emailFailed, setEmailFailed] = useState(false);
  const [workspaceUrl, setWorkspaceUrl] = useState(null);
  const [tenantName, setTenantName] = useState(null);

  // Apply a single backend event (whether from realtime or polling) to local
  // state. Idempotent — replay-safe — so we can call it from both sources
  // without coordinating.
  const apply = useCallback((evt) => {
    if (!evt) return;
    if (evt.step === "ready") {
      setCurrentStep("ready");
      if (evt.url)         setWorkspaceUrl(evt.url);
      if (evt.tenant_name) setTenantName(evt.tenant_name);
      if (evt.magic_link_sent === false) setEmailFailed(true);
    } else if (evt.step === "error") {
      setCurrentStep("error");
      setErrorMessage(evt.message || "Provisioning failed");
    } else if (evt.step === "email-failed") {
      // Soft warning — tenant is fine, email is not. Doesn't terminate.
      setEmailFailed(true);
    } else if (evt.step) {
      setCurrentStep(evt.step);
    }
  }, []);

  // Realtime: subscribe to the public progress channel, filter by id.
  const handler = useCallback((payload) => {
    if (!payload) return;
    if (payload.subscription_id && payload.subscription_id !== subscriptionId) return;
    apply(payload);
  }, [subscriptionId, apply]);

  useRealtime("provisioning-progress", handler);

  // Polling fallback. Stops once we've reached a terminal state.
  useEffect(() => {
    if (!subscriptionId) return;
    let cancelled = false;

    async function pollOnce() {
      try {
        const r = await fetch(`/api/signup/status?subscription_id=${encodeURIComponent(subscriptionId)}`);
        const data = await r.json();
        if (cancelled) return;
        if (!data?.success) return;
        if (data.tenant_provisioned) {
          apply({ step: "ready", url: data.url, tenant_name: data.tenant_name });
          return;
        }
        if (data.provisioning_step?.startsWith("error:")) {
          apply({ step: "error", message: data.provisioning_step.slice("error:".length).trim() });
          return;
        }
        if (data.provisioning_step) {
          apply({ step: data.provisioning_step });
        }
      } catch (_) { /* swallow — realtime will likely catch up */ }
    }

    // Immediate first poll so reconnecting clients get state without waiting.
    pollOnce();

    const interval = setInterval(() => {
      if (currentStep && TERMINAL_STEPS.has(currentStep)) {
        clearInterval(interval);
        return;
      }
      pollOnce();
    }, 3000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [subscriptionId, apply, currentStep]);

  // ---- render ----------------------------------------------------------
  if (!subscriptionId) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-amber-600 mb-3" />
        <p className="text-sm text-muted-foreground">
          We couldn't find a subscription reference in this URL. If you just paid and
          landed here, please check your email — your sign-in link should arrive in a few moments.
        </p>
      </div>
    );
  }

  const isReady = currentStep === "ready";
  const isError = currentStep === "error";

  // Decide each known-step's display state relative to currentStep.
  const stepIndex = KNOWN_STEPS.findIndex(s => s.id === currentStep);
  const stepStates = KNOWN_STEPS.map((s, i) => {
    if (isError) {
      // Highlight the step that failed (last announced before error) — or
      // mark the whole list as pending/error if we never got that far.
      return s.id === "ready" ? "pending" : "pending";
    }
    if (stepIndex < 0) return "pending";
    if (i < stepIndex) return "done";
    if (i === stepIndex) return s.id === "ready" ? "done" : "active";
    return "pending";
  });

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
        {isError ? (
          <>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <X className="h-5 w-5 text-red-600" />
              </div>
              <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              We couldn't finish setting up your workspace. Your payment was successful — please
              contact support and we'll get you online quickly.
            </p>
            {errorMessage && (
              <p className="text-xs text-muted-foreground font-mono mb-4">{errorMessage}</p>
            )}
            <Button asChild>
              <a href={`mailto:${support_email}?subject=Provisioning%20error%20${encodeURIComponent(subscriptionId)}`}>
                <Mail className="h-4 w-4 mr-2" /> Email support
              </a>
            </Button>
          </>
        ) : isReady ? (
          <>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                <Check className="h-5 w-5 text-green-600" />
              </div>
              <h1 className="text-xl font-semibold text-foreground">{ready_title}</h1>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              {emailFailed
                ? "Your workspace is up and running, but we couldn't send the sign-in email. Use the shortcut below — you can set a password from inside via Profile → Reset by email."
                : ready_subtitle}
            </p>
            {tenantName && (
              <p className="text-xs text-muted-foreground mb-4 font-mono">{tenantName}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {workspaceUrl && (
                <Button asChild>
                  <a href={workspaceUrl}>
                    <ExternalLink className="h-4 w-4 mr-2" /> Open workspace
                  </a>
                </Button>
              )}
              {!emailFailed && (
                <Button variant="outline" asChild>
                  <a href="mailto:">
                    <Mail className="h-4 w-4 mr-2" /> Check email
                  </a>
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-foreground mb-1">{title}</h1>
            <p className="text-sm text-muted-foreground mb-4">{subtitle}</p>
            <div className="divide-y divide-border">
              {KNOWN_STEPS.map((s, i) => (
                <StepRow key={s.id} step={s} state={stepStates[i]} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

SignupSuccess.metaFields = () => [
  {
    group: "Content",
    elements: {
      title:          { element: "INPUT",  data: { label: "Title",            description: "Heading shown while provisioning is in progress.", default: "Setting up your workspace" } },
      subtitle:       { element: "INPUT",  data: { label: "Subtitle",         description: "Subheading shown under the title.",                default: "This usually takes 15–30 seconds." } },
      ready_title:    { element: "INPUT",  data: { label: "Ready Title",      description: "Heading shown once the workspace is provisioned.", default: "Your workspace is ready" } },
      ready_subtitle: { element: "INPUT",  data: { label: "Ready Subtitle",   description: "Description shown after provisioning completes.",  default: "We sent a sign-in link to your email — click it from your inbox to enter, or use the shortcut below." } },
      support_email:  { element: "INPUT",  data: { label: "Support Email",    description: "Address used in the error 'Email support' button.", default: "support@loopar.build" } },
    },
  },
];
