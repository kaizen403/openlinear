import { McpServer } from "@modelcontextprotocol/server";
import { OpenLinearClient } from "../openlinear/client";
import { registerIssueTools } from "./tools/issues";
import { registerLabelTools } from "./tools/labels";
import { registerPhaseTools } from "./tools/phases";
import { registerPlanTools } from "./tools/plan";
import { registerProjectTools } from "./tools/projects";
import { registerTeamTools } from "./tools/teams";
import { registerWorkspaceTools } from "./tools/workspaces";

interface McpServerOptions {
  pat: string;
  apiUrl: string;
}

function createLoggingClient(baseUrl: string, pat: string): OpenLinearClient {
  const client = new OpenLinearClient(baseUrl, pat);

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || prop === "logMcpToolCall") {
        return value;
      }
      return async (...args: unknown[]) => {
        const toolName = String(prop);
        try {
          const result = await value.apply(target, args);
          await client.logMcpToolCall(toolName, true).catch(() => {});
          return result;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await client.logMcpToolCall(toolName, false, errorMsg).catch(() => {});
          throw error;
        }
      };
    },
  }) as OpenLinearClient;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "openlinear",
      version: "1.0.0",
    },
    {
      instructions:
        "Use OpenLinear tools to list workspaces, projects, teams, labels, and create project-scoped phase labels and issues. Prefer openlinear_bulk_create_plan when the user asks to turn a multi-phase plan into dashboard issues.",
    },
  );

  const client = createLoggingClient(opts.apiUrl, opts.pat);

  registerWorkspaceTools(server, client);
  registerProjectTools(server, client);
  registerTeamTools(server, client);
  registerLabelTools(server, client);
  registerPhaseTools(server, client);
  registerIssueTools(server, client);
  registerPlanTools(server, client);

  return server;
}
