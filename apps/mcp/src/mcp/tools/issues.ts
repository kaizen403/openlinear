import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { errorResult, textResult } from "./result";

const priority = z.enum(["low", "medium", "high"]);
const status = z.enum(["todo", "in_progress", "done", "cancelled"]);

export function registerIssueTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_create_issue",
    {
      description: "Create one OpenLinear issue in a project.",
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(10000).optional(),
        priority: priority.optional(),
        status: status.optional(),
        projectId: z.string().uuid().optional(),
        teamId: z.string().uuid().optional(),
        labelIds: z.array(z.string().uuid()).optional(),
        dueDate: z.string().datetime().nullable().optional(),
        model: z.string().min(1).nullable().optional(),
      }).refine((value) => value.projectId || value.teamId, {
        message: "Either projectId or teamId is required.",
        path: ["projectId"],
      }),
    },
    async (input) => {
      try {
        return textResult(await client.createTask(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "openlinear_update_issue",
    {
      description: "Update one OpenLinear issue.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(10000).nullable().optional(),
        priority: priority.optional(),
        status: status.optional(),
        labelIds: z.array(z.string().uuid()).optional(),
        teamId: z.string().uuid().optional(),
        projectId: z.string().uuid().nullable().optional(),
        dueDate: z.string().datetime().nullable().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        model: z.string().min(1).nullable().optional(),
      }),
    },
    async ({ taskId, ...data }) => {
      try {
        return textResult(await client.updateTask(taskId, data));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
