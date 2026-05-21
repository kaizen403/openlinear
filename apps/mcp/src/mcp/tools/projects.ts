import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { errorResult, textResult } from "./result";

const projectStatus = z.enum(["planned", "in_progress", "paused", "completed", "cancelled"]);

export function registerProjectTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_list_projects",
    {
      description: "List OpenLinear projects. Omit workspaceId to use all accessible projects.",
      inputSchema: z.object({
        workspaceId: z.string().uuid().optional(),
      }),
    },
    async ({ workspaceId }) => {
      try {
        return textResult(await client.listProjects({ workspaceId }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "openlinear_create_project",
    {
      description: "Create an OpenLinear project. Omit workspaceId to use the user's default workspace.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional(),
        key: z.string().regex(/^[A-Z0-9]{2,12}$/).optional(),
        workspaceId: z.string().uuid().optional(),
        teamIds: z.array(z.string().uuid()).min(1).max(1).optional(),
        status: projectStatus.optional(),
      }),
    },
    async (input) => {
      try {
        return textResult(await client.createProject(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "openlinear_get_project",
    {
      description: "Get one OpenLinear project by id.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
      }),
    },
    async ({ projectId }) => {
      try {
        return textResult(await client.getProject(projectId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
