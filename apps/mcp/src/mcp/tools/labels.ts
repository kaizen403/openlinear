import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { OpenLinearClient } from "../../openlinear/client";
import { errorResult, textResult } from "./result";

export function registerLabelTools(server: McpServer, client: OpenLinearClient) {
  server.registerTool(
    "openlinear_list_labels",
    {
      description: "List project-scoped OpenLinear labels, including phase labels named phase:N — Name.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
      }),
    },
    async ({ projectId }) => {
      try {
        return textResult(await client.listLabels({ projectId }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "openlinear_create_label",
    {
      description: "Create a project-scoped OpenLinear label.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        name: z.string().min(1).max(50),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        priority: z.number().int().min(0).optional(),
      }),
    },
    async (input) => {
      try {
        return textResult(await client.createLabel(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
