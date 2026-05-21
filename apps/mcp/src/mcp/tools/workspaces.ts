import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { errorResult, textResult } from "./result";

export function registerWorkspaceTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_list_workspaces",
    {
      description: "List OpenLinear workspaces visible to the authenticated user.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return textResult(await client.listWorkspaces());
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
