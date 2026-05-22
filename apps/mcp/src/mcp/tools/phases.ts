import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { errorResult, textResult } from "./result";

export const DEFAULT_PHASE_COLORS = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
  "#6366F1",
  "#14B8A6",
  "#E11D48",
];

export function phaseLabelName(phaseNumber: number, name: string): string {
  return `phase:${phaseNumber} — ${name}`;
}

export function registerPhaseTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_create_phase",
    {
      description: "Create a project-scoped phase label using the OpenLinear naming convention phase:N — Name.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        phaseNumber: z.number().int().min(1).max(100),
        name: z.string().min(1).max(40),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      }),
    },
    async ({ projectId, phaseNumber, name, color }) => {
      try {
        return textResult(await client.createLabel({
          projectId,
          name: phaseLabelName(phaseNumber, name),
          color: color ?? DEFAULT_PHASE_COLORS[(phaseNumber - 1) % DEFAULT_PHASE_COLORS.length],
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
