import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Express, Request, Response } from "express";
import { extractPat } from "../auth";
import { createMcpServer } from "./server";

function apiUrl(): string {
  return process.env.OPENLINEAR_API_URL || "https://api.openlinear.tech";
}

export function mountMcpRoutes(app: Express) {
  app.post("/mcp", async (req: Request, res: Response) => {
    const pat = extractPat(req);
    if (!pat) {
      res.status(401).json({ error: "Missing or invalid Bearer token" });
      return;
    }

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const server = createMcpServer({ pat, apiUrl: apiUrl() });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({ error: "SSE not supported in stateless mode" });
  });

  app.delete("/mcp", (_req: Request, res: Response) => {
    res.status(204).end();
  });
}
