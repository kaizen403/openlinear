import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { DEFAULT_PHASE_COLORS, phaseLabelName } from "./phases";
import { errorResult, formatError, textResult } from "./result";

const planInputSchema = z.object({
  workspaceId: z.string().optional().describe("Omit to use default workspace."),
  teamId: z.string().optional().describe("Team ID (e.g. team-abc123). Used for phase labels and project team membership. Omit if unknown."),
  project: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    key: z.string().regex(/^[A-Z0-9]{2,12}$/).optional().describe("Auto-generated if omitted."),
  }),
  phases: z.array(z.object({
    name: z.string().min(1).max(100).describe("Phase name, e.g. 'Foundation'"),
    description: z.string().max(500).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    tasks: z.array(z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(10000).optional(),
      priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
    })).min(1).max(50),
  })).min(1).max(10),
});

export function registerPlanTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_bulk_create_plan",
    {
      description:
        "Create an entire project plan in one call. Creates a project, phase labels, and all tasks organized by phase. This is the primary tool for turning an AI-generated execution plan into OpenLinear issues.",
      inputSchema: planInputSchema,
    },
    async ({ workspaceId, teamId, project, phases }) => {
      try {
        const createdProject = await client.createProject({
          ...project,
          workspaceId,
          ...(teamId ? { teamIds: [teamId] } : {}),
          status: "planned",
        });

        const phaseResults: Array<{
          name: string;
          labelId?: string;
          labelName?: string;
          taskCount: number;
          taskIds: string[];
          failed?: Array<{ index: number; error: string }>;
          error?: string;
        }> = [];

        for (let i = 0; i < phases.length; i += 1) {
          const phase = phases[i];
          try {
            let labelId: string | undefined;
            let labelName: string | undefined;

            if (teamId) {
              const label = await client.createLabel({
                teamId,
                name: phaseLabelName(i + 1, phase.name),
                color: phase.color ?? DEFAULT_PHASE_COLORS[i % DEFAULT_PHASE_COLORS.length],
              });
              labelId = label.id;
              labelName = label.name;
            }

            const bulkResult = await client.bulkCreateTasks({
              projectId: createdProject.id,
              tasks: phase.tasks.map((task) => ({
                ...task,
                status: "todo",
                ...(labelId ? { labelIds: [labelId] } : {}),
              })),
            });

            phaseResults.push({
              name: phase.name,
              ...(labelId ? { labelId, labelName } : {}),
              taskCount: bulkResult.created.length,
              taskIds: bulkResult.created.map((task) => task.id),
              ...(bulkResult.failed.length ? { failed: bulkResult.failed } : {}),
            });
          } catch (error) {
            phaseResults.push({
              name: phase.name,
              taskCount: 0,
              taskIds: [],
              error: formatError(error),
            });
          }
        }

        const result = {
          projectId: createdProject.id,
          projectKey: createdProject.key,
          projectName: createdProject.name,
          totalTasks: phaseResults.reduce((sum, phase) => sum + phase.taskCount, 0),
          phases: phaseResults,
        };

        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
