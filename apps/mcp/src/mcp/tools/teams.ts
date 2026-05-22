import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { errorResult, textResult } from "./result";

export function registerTeamTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_list_teams",
    {
      description: "List OpenLinear teams. Teams belong to projects; filter by projectId or workspaceId when possible.",
      inputSchema: z.object({
        projectId: z.string().uuid().optional(),
        workspaceId: z.string().min(1).optional(),
      }),
    },
    async ({ projectId, workspaceId }) => {
      try {
        return textResult(await client.listTeams({ projectId, workspaceId }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "openlinear_create_team",
    {
      description: "Create a team inside a project. Team keys must start with a letter and are stored uppercase.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        name: z.string().min(1).max(50),
        key: z.string().trim().min(1).max(10).regex(/^[A-Za-z][A-Za-z0-9]*$/),
        description: z.string().max(500).optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        icon: z.string().max(50).optional(),
        private: z.boolean().optional(),
      }),
    },
    async (input) => {
      try {
        return textResult(await client.createTeam({
          ...input,
          key: input.key.toUpperCase(),
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
