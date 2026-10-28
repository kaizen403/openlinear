import * as z from 'zod';
import type { ApiLabel, OpenLinearApi } from '../../openlinear/api';
import { OpenLinearApiError } from '../../openlinear/errors';
import { HexColor, id } from '../inputs';
import { defaultPhaseColor, LabelShape, phaseLabelName, toLabel } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

/**
 * Create a label, or return the existing one: label names are unique per
 * project (`@@unique([projectId, name])`), so a 409 means it already exists.
 * This makes label and phase creation safe to retry.
 */
export async function ensureLabel(
  api: OpenLinearApi,
  payload: { projectId: string; name: string; color: string; priority?: number },
  signal?: AbortSignal,
): Promise<{ label: ApiLabel; created: boolean }> {
  try {
    return { label: await api.createLabel(payload, signal), created: true };
  } catch (error) {
    if (!(error instanceof OpenLinearApiError) || error.status !== 409) throw error;
    const existing = (await api.listLabels(payload.projectId, signal)).find((label) => label.name === payload.name);
    if (!existing) throw error;
    return { label: existing, created: false };
  }
}

const labelResult = z.object({
  label: LabelShape,
  created: z.boolean().describe('false when a label with this name already existed and was returned instead'),
});

export const listLabels = defineTool({
  name: 'openlinear_list_labels',
  title: 'List labels and phases',
  description:
    'List the labels of a project. Phase labels ("phase:N — Name") carry a parsed `phase`; set phasesOnly to list just the phases.',
  input: z.strictObject({
    projectId: id('Project'),
    phasesOnly: z.boolean().default(false).describe('Return only phase labels, ordered by phase number'),
  }),
  output: z.object({ labels: z.array(LabelShape) }),
  annotations: READ_ONLY,
  scopes: ['read', 'projects:read'],
  async run({ projectId, phasesOnly }, { api, signal }) {
    const labels = (await api.listLabels(projectId, signal)).map(toLabel);
    const selected = phasesOnly ? labels.filter((label) => label.phase !== null) : labels;
    if (phasesOnly) selected.sort((a, b) => (a.phase?.number ?? 0) - (b.phase?.number ?? 0));
    return { labels: selected };
  },
});

export const createLabel = defineTool({
  name: 'openlinear_create_label',
  title: 'Create label',
  description:
    'Create a label in a project, or return the existing label with the same name (created: false). For phases use openlinear_create_phase.',
  input: z.strictObject({
    projectId: id('Project'),
    name: z.string().trim().min(1).max(50).describe('Label name, unique within the project'),
    color: HexColor,
    priority: z.number().int().min(0).optional().describe('Higher sorts first'),
  }),
  output: labelResult,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'labels:write + projects:read'],
  async run(args, { api, signal }) {
    const { label, created } = await ensureLabel(api, args, signal);
    return { label: toLabel(label), created };
  },
});

export const createPhase = defineTool({
  name: 'openlinear_create_phase',
  title: 'Create phase',
  description:
    'Create the phase label "phase:N — Name" in a project (or return it if it exists). Attach it to issues via labelIds to group them by phase.',
  input: z.strictObject({
    projectId: id('Project'),
    phaseNumber: z.number().int().min(1).max(100).describe('N in "phase:N — Name"'),
    name: z.string().trim().min(1).max(40).describe('Phase name, e.g. Foundation'),
    color: HexColor.optional().describe('Defaults to a fixed 10-colour palette by phase number'),
  }),
  output: labelResult,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'labels:write + projects:read'],
  async run({ projectId, phaseNumber, name, color }, { api, signal }) {
    const { label, created } = await ensureLabel(
      api,
      {
        projectId,
        name: phaseLabelName(phaseNumber, name),
        color: color ?? defaultPhaseColor(phaseNumber),
        priority: phaseNumber - 1,
      },
      signal,
    );
    return { label: toLabel(label), created };
  },
});
