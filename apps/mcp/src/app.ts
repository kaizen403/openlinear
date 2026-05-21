import express from "express";
import { mountMcpRoutes } from "./mcp/transport";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  mountMcpRoutes(app);

  return app;
}
