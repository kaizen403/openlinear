"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Ban, Check, CircleHelp, Clock, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isConfirmationExpired, type ChatConfirmation, type ConfirmationState } from "@/hooks/chat-stream-state";

interface ConfirmationCardProps {
  confirmation: ChatConfirmation;
  /** Client lifecycle; undefined renders as pending. */
  state?: ConfirmationState;
  /** False when the surface can't send (read-only transcript): only the typed code is offered. */
  interactive?: boolean;
  /** A reply is streaming; confirming waits for it to finish. */
  busy?: boolean;
  onConfirm?: (code: string) => boolean;
  onDismiss?: (code: string) => void;
}

const MAX_LISTED_ISSUES = 50;

/** Re-render on an interval while `active` (expiry countdown). */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function formatRemaining(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.ceil(ms / 60_000);
    return `${minutes} min`;
  }
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatStatus(status: string | null): string {
  return status ? status.replace(/_/g, " ") : "unknown";
}

function changeHeadline(confirmation: ChatConfirmation): string {
  const preview = confirmation.preview;
  if (!preview) return confirmation.summary;
  const count = preview.issues.length;
  const noun = `issue${count === 1 ? "" : "s"}`;
  if (preview.kind === "status_change") return `Set status to ${formatStatus(preview.status)} on ${count} ${noun}`;
  if (preview.kind === "archive") return `Archive ${count} ${noun}`;
  return confirmation.summary;
}

export function ConfirmationCard({
  confirmation,
  state,
  interactive = true,
  busy = false,
  onConfirm,
  onDismiss,
}: ConfirmationCardProps) {
  const phase = state?.phase ?? "pending";
  const pending = phase === "pending";
  const now = useNow(pending);
  const expired = pending && isConfirmationExpired(confirmation, now);
  const remainingMs = Date.parse(confirmation.expiresAt) - now;
  const clickedRef = useRef(false);
  const headingId = useId();
  const expiryId = useId();
  const preview = confirmation.preview;

  // A card can return to pending when its confirmation never reached the server.
  useEffect(() => {
    if (pending) clickedRef.current = false;
  }, [pending]);

  const canAct = interactive && pending && !expired && Boolean(onConfirm);
  const confirmDisabled = !canAct || busy;

  const handleConfirm = () => {
    if (confirmDisabled || clickedRef.current || !onConfirm) return;
    clickedRef.current = true;
    if (!onConfirm(confirmation.code)) clickedRef.current = false;
  };

  const announcement = (() => {
    if (expired) return "Confirmation expired. Nothing changed.";
    switch (phase) {
      case "submitting":
        return "Confirming the change.";
      case "confirmed":
        return "Change confirmed and applied.";
      case "rejected":
        return state?.error ? `Confirmation refused. ${state.error.message}` : "Confirmation refused.";
      case "outcome_unknown":
        return "The confirmed change was interrupted; its outcome is unknown.";
      case "superseded":
        return "This preview was replaced by a newer one.";
      case "unresolved":
        return "Confirmation sent, but the change was not applied.";
      case "dismissed":
        return state?.revoke === "failed"
          ? "Change dismissed. The server did not cancel the code; it works until it expires."
          : "Change dismissed. Nothing changed.";
      default:
        return "";
    }
  })();

  const tone =
    phase === "confirmed"
      ? "border-success/40"
      : phase === "rejected" || phase === "outcome_unknown"
        ? "border-destructive/50"
        : phase === "pending" && !expired
          ? "border-warning/50"
          : "border-linear-border";

  return (
    <section
      aria-labelledby={headingId}
      className={cn("rounded-sm border bg-linear-bg-secondary text-xs", tone)}
      data-confirmation-code={confirmation.code}
      data-phase={expired ? "expired" : phase}
    >
      <header className="flex items-start gap-2 border-b border-linear-border px-3 py-2">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-xs font-medium text-linear-text">
            {changeHeadline(confirmation)}
          </h3>
          <p className="mt-0.5 text-[11px] text-linear-text-tertiary">
            Needs your confirmation. Nothing has changed yet.
          </p>
        </div>
      </header>

      {preview && (
        <div className="space-y-1.5 px-3 py-2">
          {preview.wholeProject && (
            <p className="text-[11px] text-warning">Selection: every active issue in this project.</p>
          )}
          {preview.issues.length > 0 && (
            <ul
              className="max-h-56 divide-y divide-linear-border overflow-y-auto rounded-sm border border-linear-border"
              aria-label={`${preview.issues.length} affected issue${preview.issues.length === 1 ? "" : "s"}`}
            >
              {preview.issues.slice(0, MAX_LISTED_ISSUES).map((issue, index) => (
                <li key={issue.id ?? `${issue.identifier ?? "issue"}-${index}`} className="flex items-center gap-2 px-2 py-1">
                  {issue.identifier && (
                    <span className="shrink-0 font-mono text-[10px] text-linear-text-tertiary">{issue.identifier}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-linear-text" title={issue.title}>{issue.title}</span>
                  {preview.kind === "status_change" ? (
                    <span className="shrink-0 text-[10px] text-linear-text-secondary">
                      {formatStatus(issue.status)} <span aria-hidden="true">→</span>
                      <span className="sr-only">to</span> {formatStatus(preview.status)}
                    </span>
                  ) : preview.kind === "archive" ? (
                    <span className="shrink-0 text-[10px] text-linear-text-secondary">{formatStatus(issue.status)} → archived</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {preview.issues.length > MAX_LISTED_ISSUES && (
            <p className="text-[11px] text-linear-text-tertiary">
              and {preview.issues.length - MAX_LISTED_ISSUES} more.
            </p>
          )}
          {preview.unchangedCount > 0 && (
            <p className="text-[11px] text-linear-text-tertiary">
              {preview.unchangedCount} selected issue{preview.unchangedCount === 1 ? " already has" : "s already have"} this status and won&apos;t change.
            </p>
          )}
          {preview.notFound.length > 0 && (
            <p className="text-[11px] text-linear-text-tertiary">Not found, skipped: {preview.notFound.join(", ")}</p>
          )}
          {preview.argumentsText && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-linear-bg-tertiary p-2 font-mono text-[11px] text-linear-text-secondary">
              {preview.argumentsText}
            </pre>
          )}
        </div>
      )}

      <footer className="space-y-1.5 border-t border-linear-border px-3 py-2">
        {pending && !expired && (
          <>
            {interactive && onConfirm ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={confirmDisabled}
                  aria-describedby={expiryId}
                  className="inline-flex h-7 items-center gap-1 rounded-sm bg-linear-accent px-2.5 text-xs font-medium text-white transition-colors hover:bg-linear-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linear-accent focus-visible:ring-offset-2 focus-visible:ring-offset-linear-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Check className="h-3 w-3" aria-hidden="true" />
                  Confirm
                </button>
                {onDismiss && (
                  <button
                    type="button"
                    onClick={() => onDismiss(confirmation.code)}
                    className="inline-flex h-7 items-center rounded-sm border border-linear-border px-2.5 text-xs text-linear-text-secondary transition-colors hover:bg-linear-bg-tertiary hover:text-linear-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linear-accent focus-visible:ring-offset-2 focus-visible:ring-offset-linear-bg"
                  >
                    Dismiss
                  </button>
                )}
                {busy && <span className="text-[11px] text-linear-text-tertiary">Available when the reply finishes.</span>}
              </div>
            ) : null}
            <p id={expiryId} className="flex flex-wrap items-center gap-1 text-[11px] text-linear-text-tertiary">
              <Clock className="h-3 w-3" aria-hidden="true" />
              <span>
                Expires at {formatClock(confirmation.expiresAt)}
                {Number.isFinite(remainingMs) ? ` (in ${formatRemaining(remainingMs)})` : ""}.
              </span>
              <span>
                {interactive && onConfirm ? "Or reply with " : "To confirm, reply with "}
                <code className="select-text rounded-sm bg-linear-bg-tertiary px-1 font-mono text-linear-text-secondary">{confirmation.code}</code>.
              </span>
            </p>
            {state?.error && (
              <p className="text-[11px] text-destructive">
                {state.error.message}
                {state.error.hint ? ` ${state.error.hint}` : ""}
              </p>
            )}
          </>
        )}

        {expired && (
          <p className="flex items-center gap-1.5 text-[11px] text-linear-text-secondary">
            <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
            Expired at {formatClock(confirmation.expiresAt)}. Nothing changed; ask the assistant for a fresh preview.
          </p>
        )}

        {phase === "submitting" && (
          <p className="flex items-center gap-1.5 text-[11px] text-linear-text-secondary">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Confirming…
          </p>
        )}

        {phase === "confirmed" && (
          <p className="flex items-center gap-1.5 text-[11px] text-success">
            <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            Confirmed{state?.outcome ? `: ${state.outcome}` : "."}
          </p>
        )}

        {(phase === "rejected" || phase === "outcome_unknown") && (
          <div className={cn("flex items-start gap-1.5 text-[11px]", phase === "rejected" ? "text-destructive" : "text-warning")}>
            {phase === "rejected" ? (
              <XCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <CircleHelp className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <p>
              {state?.error?.message ?? (phase === "rejected" ? "The server refused this confirmation." : "The change was interrupted; it may or may not have been applied.")}
              {state?.error?.hint ? ` ${state.error.hint}` : ""}
            </p>
          </div>
        )}

        {phase === "superseded" && (
          <p className="text-[11px] text-linear-text-tertiary">Replaced by a newer preview. Nothing changed from this one.</p>
        )}

        {phase === "unresolved" && (
          <p className="text-[11px] text-linear-text-secondary">
            Sent, but the assistant didn&apos;t apply it in that reply. To try again, reply with{" "}
            <code className="select-text rounded-sm bg-linear-bg-tertiary px-1 font-mono">{confirmation.code}</code>{" "}
            before it expires, or ask for a fresh preview.
          </p>
        )}

        {phase === "dismissed" && (
          <div className="space-y-0.5 text-[11px]">
            <p className="flex items-center gap-1.5 text-linear-text-tertiary">
              <Ban className="h-3 w-3 shrink-0" aria-hidden="true" />
              {state?.revoke === "pending"
                ? "Dismissed. Nothing changed. Cancelling the code…"
                : state?.revoke === "failed"
                  ? "Dismissed here. Nothing changed."
                  : "Dismissed. Nothing changed, and the code can no longer be used."}
            </p>
            {state?.revoke === "failed" && (
              <p className="text-warning">
                The server didn&apos;t cancel the code, so it still works until{" "}
                {new Date(confirmation.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
                {state.error?.message ? ` ${state.error.message}` : ""}
              </p>
            )}
          </div>
        )}

        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </footer>
    </section>
  );
}
