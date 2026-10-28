"use client"

import { useEffect, useId, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ExternalLink, Plus, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { SettingsPanel, SettingsSection } from "@/components/settings/settings-layout"
import { ApiError } from "@/lib/api/fetch"
import { describeApiError } from "@/lib/api/errors"
import {
  fetchProjectGitHubApp,
  fetchProjectVerificationSettings,
  saveProjectVerificationSettings,
  type VerificationPolicy,
} from "@/lib/api/verification"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn, openExternal } from "@/lib/utils"
import {
  MAX_CHECKS,
  MAX_SETUP_STEPS,
  POLICY_COPY,
  draftCheck,
  draftProblems,
  serverProblems,
  toBody,
  toDraft,
  type CheckDraft,
  type VerificationDraft,
} from "./verification-settings-model"

const POLICIES: VerificationPolicy[] = ["warn", "require-pass", "off"]

/**
 * W11a: what "done" means for this project — checks run against the agent's
 * commit in a pristine sandboxed checkout before anything is published.
 * Workspace owners/admins edit (the checks run on every member's machine);
 * everyone else sees the settings read-only. W16a: the same form edits the
 * setup steps that prepare the worktree before the agent starts.
 */
export function VerificationSettingsSection({ projectId }: { projectId: string }) {
  const client = useAppQueryClient()
  const query = useQuery({
    queryKey: queryKeys.projects.verification(projectId),
    queryFn: () => fetchProjectVerificationSettings(projectId),
    enabled: Boolean(projectId),
  }, client)
  const [draft, setDraft] = useState<VerificationDraft | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [readOnly, setReadOnly] = useState(false)
  const setupHeadingId = useId()

  useEffect(() => {
    if (query.data) setDraft(toDraft(query.data.settings))
  }, [query.data])

  const save = useMutation({
    mutationFn: (next: VerificationDraft) => saveProjectVerificationSettings(projectId, toBody(next)),
    onSuccess: (view) => {
      client.setQueryData(queryKeys.projects.verification(projectId), view)
      setProblems([])
      toast.success("Verification settings saved")
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 403) setReadOnly(true)
      const fromServer = error instanceof ApiError ? serverProblems(error.details) : []
      if (fromServer.length > 0) {
        setProblems(fromServer)
        return
      }
      const described = describeApiError(error, "Couldn't save the verification settings.")
      toast.error(described.message, described.hint ? { description: described.hint } : undefined)
    },
  }, client)

  const update = (patch: Partial<VerificationDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current))
  const updateCheck = (key: string, patch: Partial<CheckDraft>) =>
    setDraft((current) => current ? { ...current, checks: current.checks.map((check) => (check.key === key ? { ...check, ...patch } : check)) } : current)
  const updateStep = (key: string, patch: Partial<CheckDraft>) =>
    setDraft((current) => current ? { ...current, setup: current.setup.map((step) => (step.key === key ? { ...step, ...patch } : step)) } : current)

  const submit = () => {
    if (!draft) return
    const local = draftProblems(draft)
    setProblems(local)
    if (local.length === 0) save.mutate(draft)
  }

  return (
    <SettingsSection
      title="Verification"
      description="Checks that must run against the agent's commit, in a clean sandboxed checkout, before a run publishes. A repository can also define them in .openlinear/checks.json; project checks take precedence."
      icon={<ShieldCheck className="h-4 w-4" />}
    >
      <SettingsPanel className="max-w-2xl p-4">
        {query.isLoading || !draft ? (
          <p className="text-xs text-linear-text-tertiary">{query.isError ? describeApiError(query.error, "Couldn't load the verification settings.").message : "Loading…"}</p>
        ) : (
          <fieldset disabled={readOnly || save.isPending} className="space-y-5">
            {readOnly && (
              <p role="note" className="text-xs text-linear-text-secondary">Only workspace owners and admins can change these settings.</p>
            )}
            <PolicyField value={draft.policy} onChange={(policy) => update({ policy })} />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-linear-text-secondary">Checks</Label>
                <span className="text-xs text-linear-text-tertiary">{draft.checks.length}/{MAX_CHECKS}</span>
              </div>
              {draft.checks.length === 0 && (
                <p className="text-xs text-linear-text-tertiary">
                  No project checks. {draft.repositoryChecks ? "The repository's .openlinear/checks.json is used when it exists." : "Repository check files are ignored."}
                  {draft.policy === "require-pass" ? " With no checks at all, nothing can pass, so nothing is published." : ""}
                </p>
              )}
              <ul className="space-y-3">
                {draft.checks.map((check, index) => (
                  <CheckRow
                    key={check.key}
                    check={check}
                    index={index}
                    onChange={(patch) => updateCheck(check.key, patch)}
                    onRemove={() => update({ checks: draft.checks.filter((item) => item.key !== check.key) })}
                  />
                ))}
              </ul>
              {draft.checks.length < MAX_CHECKS && (
                <Button type="button" variant="outline" size="sm" onClick={() => update({ checks: [...draft.checks, draftCheck()] })}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Add check
                </Button>
              )}
            </div>

            <ToggleField
              label="Use the repository's .openlinear/checks.json"
              description="Read from the run's base commit — the agent can't change what it's graded with."
              checked={draft.repositoryChecks}
              onChange={(repositoryChecks) => update({ repositoryChecks })}
            />
            <ToggleField
              label="Detect checks from package.json"
              description="When nothing else defines checks: install with the lockfile (scripts off), then the typecheck and test scripts."
              checked={draft.autoDetect}
              onChange={(autoDetect) => update({ autoDetect })}
            />

            <section aria-labelledby={setupHeadingId} className="space-y-2 border-t border-linear-border pt-4">
              <div className="flex items-center justify-between">
                <h3 id={setupHeadingId} className="text-xs font-medium text-linear-text">Setup before the agent starts</h3>
                <span className="text-xs text-linear-text-tertiary">{draft.setup.length}/{MAX_SETUP_STEPS}</span>
              </div>
              <p className="text-xs text-linear-text-tertiary">
                Commands run in order in the run&apos;s worktree before the agent&apos;s first prompt — install dependencies here: the agent itself has no network.
                A required step that fails stops the run before the agent starts; the worktree is kept.
              </p>
              <ul className="space-y-3">
                {draft.setup.map((step, index) => (
                  <CheckRow
                    key={step.key}
                    noun="Setup step"
                    check={step}
                    index={index}
                    onChange={(patch) => updateStep(step.key, patch)}
                    onRemove={() => update({ setup: draft.setup.filter((item) => item.key !== step.key) })}
                  />
                ))}
              </ul>
              {draft.setup.length < MAX_SETUP_STEPS && (
                <Button type="button" variant="outline" size="sm" onClick={() => update({ setup: [...draft.setup, draftCheck()] })}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Add setup step
                </Button>
              )}
            </section>

            {problems.length > 0 && (
              <ul role="alert" className="space-y-1 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {problems.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
            )}
            {!readOnly && (
              <Button type="button" size="sm" onClick={submit} disabled={save.isPending}>
                {save.isPending ? "Saving..." : "Save verification settings"}
              </Button>
            )}
          </fieldset>
        )}
      </SettingsPanel>
      <GitHubAppStatus projectId={projectId} />
    </SettingsSection>
  )
}

function PolicyField({ value, onChange }: { value: VerificationPolicy; onChange: (policy: VerificationPolicy) => void }) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-linear-text-secondary">When checks fail</Label>
      <Select value={value} onValueChange={(next) => onChange(next as VerificationPolicy)}>
        <SelectTrigger id={id} className="h-8 w-64 border-linear-border bg-linear-bg-secondary text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {POLICIES.map((policy) => (
            <SelectItem key={policy} value={policy} className="text-xs">{POLICY_COPY[policy].label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-linear-text-tertiary">{POLICY_COPY[value].description}</p>
    </div>
  )
}

function ToggleField({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs text-linear-text">{label}</Label>
        <p className="text-xs text-linear-text-tertiary">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** One check or setup step: name, command line, timeout, required, registry access. */
function CheckRow({ check, index, onChange, onRemove, noun = "Check" }: {
  check: CheckDraft
  index: number
  onChange: (patch: Partial<CheckDraft>) => void
  onRemove: () => void
  noun?: "Check" | "Setup step"
}) {
  const base = useId()
  const examples = noun === "Check" ? { name: "Unit tests", command: "pnpm test" } : { name: "Install dependencies", command: "pnpm install --frozen-lockfile" }
  return (
    <li className="space-y-2 rounded-sm border border-linear-border p-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label={`${noun} ${index + 1} name`}
          value={check.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder={`Name, e.g. ${examples.name}`}
          className="h-8 flex-1 border-linear-border bg-linear-bg-secondary text-xs"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${check.name || `${noun.toLowerCase()} ${index + 1}`}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <Input
        aria-label={`${noun} ${index + 1} command`}
        value={check.command}
        onChange={(event) => onChange({ command: event.target.value })}
        placeholder={`Command, e.g. ${examples.command}`}
        className="h-8 border-linear-border bg-linear-bg-secondary font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={`${base}-timeout`} className="text-xs text-linear-text-secondary">Timeout (s)</Label>
          <Input
            id={`${base}-timeout`}
            inputMode="numeric"
            value={check.timeoutSeconds}
            onChange={(event) => onChange({ timeoutSeconds: event.target.value })}
            className="h-7 w-20 border-linear-border bg-linear-bg-secondary text-xs"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-linear-text-secondary">
          <Checkbox checked={check.required} onCheckedChange={(value) => onChange({ required: value === true })} />
          Required
        </label>
        <label className="flex items-center gap-1.5 text-xs text-linear-text-secondary">
          <Checkbox checked={check.registries} onCheckedChange={(value) => onChange({ registries: value === true })} />
          Needs package registries
        </label>
      </div>
      {check.cwd && <p className="text-xs text-linear-text-tertiary">Runs in {check.cwd}/</p>}
    </li>
  )
}

/** W10a: whether runs get a repo-scoped GitHub App token (admins see this; others get nothing). */
function GitHubAppStatus({ projectId }: { projectId: string }) {
  const client = useAppQueryClient()
  const status = useQuery({
    queryKey: queryKeys.projects.githubApp(projectId),
    queryFn: () => fetchProjectGitHubApp(projectId),
    enabled: Boolean(projectId),
    retry: false,
  }, client)
  const data = status.data
  if (!data || !data.configured || !data.repository) return null
  const ok = data.installed === true && !data.suspended && data.missingPermissions.length === 0
  const link = ok ? null : data.installed ? data.manageUrl : data.installUrl
  const text = ok
    ? `Runs use a GitHub App token limited to ${data.repository}.`
    : data.installed === false
      ? `The OpenLinear GitHub App isn't installed on ${data.repository}. ${data.fallbackPolicy === "deny" ? "Runs can't push until it is." : "Runs use your own GitHub sign-in until it is."}`
      : data.suspended
        ? "The OpenLinear GitHub App installation is suspended."
        : `The GitHub App is missing permissions: ${data.missingPermissions.join(", ")}.`
  return (
    <SettingsPanel className={cn("mt-3 max-w-2xl p-3", !ok && "border-warning/40")}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-linear-text-secondary">{text}</p>
        {link && (
          <Button type="button" variant="outline" size="sm" onClick={() => openExternal(link)}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {data.installed ? "Manage" : "Install"}
          </Button>
        )}
      </div>
    </SettingsPanel>
  )
}
