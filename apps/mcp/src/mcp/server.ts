import { McpServer } from "@modelcontextprotocol/server";
import { OpenLinearClient } from "../openlinear/client";
import { registerIssueTools } from "./tools/issues";
import { registerPhaseTools } from "./tools/phases";
import { registerPlanTools } from "./tools/plan";
import { registerProjectTools } from "./tools/projects";
import { registerWorkspaceTools } from "./tools/workspaces";

interface McpServerOptions {
  pat: string;
  apiUrl: string;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: "openlinear",
      version: "1.0.0",
    },
    {
      instructions:
        "Use OpenLinear tools to list workspaces/projects and create projects, phase labels, and issues. Prefer openlinear_bulk_create_plan when the user asks to turn a multi-phase plan into dashboard issues.",
    },
  );

  const client = new OpenLinearClient(opts.apiUrl, opts.pat);

  registerWorkspaceTools(server, client);
  registerProjectTools(server, client);
  registerPhaseTools(server, client);
  registerIssueTools(server, client);
  registerPlanTools(server, client);

  return server;
}
