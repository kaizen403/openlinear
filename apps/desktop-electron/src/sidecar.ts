import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { app } from "electron";
import * as path from "node:path";

let sidecarProcess: ChildProcess | null = null;
let sidecarPort: number | null = null;

const STORE_FILE = "settings.json";
const DEFAULT_DATABASE_URL = "postgresql://openlinear:openlinear@localhost:5432/openlinear";
const DEFAULT_FRONTEND_URL = "http://127.0.0.1:3000";

export interface SidecarOutput {
  stream: string;
  data: string;
}

export interface SidecarExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SidecarReady {
  port: number;
  api_url: string;
  health_url: string;
}

export function getSidecarPort(): number | null {
  return sidecarPort;
}

function getStorePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

async function readStoreString(key: string): Promise<string | undefined> {
  try {
    const fs = await import("node:fs/promises");
    const data = await fs.readFile(getStorePath(), "utf-8");
    const store = JSON.parse(data) as Record<string, unknown>;
    const value = store[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object" && address.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port from address")));
      }
    });
    server.on("error", (err) => reject(err));
  });
}

async function buildSidecarEnv(port: number): Promise<Record<string, string>> {
  const databaseUrl =
    (await readStoreString("database_url")) ??
    process.env.DATABASE_URL ??
    DEFAULT_DATABASE_URL;

  const frontendUrl =
    (await readStoreString("frontend_url")) ??
    process.env.FRONTEND_URL ??
    DEFAULT_FRONTEND_URL;

  const githubClientId =
    (await readStoreString("github_client_id")) ??
    process.env.GITHUB_CLIENT_ID ??
    "";

  const reposDir =
    (await readStoreString("repos_dir")) ??
    process.env.REPOS_DIR ??
    path.join(app.getPath("temp"), "openlinear-repos");

  const corsOrigin =
    process.env.CORS_ORIGIN ??
    `${frontendUrl},tauri://localhost,https://tauri.localhost`;

  const env: Record<string, string> = {
    API_PORT: String(port),
    DATABASE_URL: databaseUrl,
    FRONTEND_URL: frontendUrl,
    GITHUB_CLIENT_ID: githubClientId,
    REPOS_DIR: reposDir,
    CORS_ORIGIN: corsOrigin,
    OPENLINEAR_TRUST_PROXY_AUTH: "1",
    OPENLINEAR_SKIP_DOTENV: "1",
  };

  for (const key of [
    "GITHUB_CLIENT_SECRET",
    "GITHUB_REDIRECT_URI",
    "GITHUB_TOKEN",
    "JWT_SECRET",
    "BRAINSTORM_API_KEY",
    "BRAINSTORM_MODEL",
    "BRAINSTORM_PROVIDER",
    "BRAINSTORM_BASE_URL",
    "OAUTH_INTERCEPTOR_PORT",
    "CHAT_LLM_BASE_URL",
    "CHAT_LLM_API_KEY",
    "CHAT_LLM_MODEL",
    "CHAT_LLM_TIMEOUT_MS",
    "CHAT_RATE_LIMIT_PER_MIN",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

function getSidecarBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch;

  const isPackaged = app.isPackaged;

  let binaryDir: string;
  if (isPackaged) {
    binaryDir = path.join(process.resourcesPath, "binaries");
  } else {
    binaryDir = path.resolve(
      __dirname,
      "../../desktop/src-tauri/binaries"
    );
  }

  const targetTriple =
    platform === "darwin"
      ? arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin"
      : platform === "linux"
        ? "x86_64-unknown-linux-gnu"
        : platform === "win32"
          ? "x86_64-pc-windows-msvc"
          : `${arch}-unknown-${platform}`;

  const binaryName = `openlinear-sidecar-${targetTriple}`;
  return path.join(binaryDir, binaryName);
}

export async function launchSidecar(
  emit: (channel: string, payload: unknown) => void
): Promise<number> {
  if (process.env.OPENLINEAR_SKIP_SIDECAR === "1") {
    const port = Number(process.env.API_PORT ?? 3001);
    sidecarPort = port;
    const apiUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${apiUrl}/health`;
    emit("sidecar:ready", { port, api_url: apiUrl, health_url: healthUrl });
    return port;
  }

  if (sidecarProcess) {
    return sidecarPort ?? 3001;
  }

  const port = await pickFreePort();
  const env = await buildSidecarEnv(port);
  const binaryPath = getSidecarBinaryPath();

  const useNpmScript = !isPackaged() && !(await fileExists(binaryPath));

  if (useNpmScript) {
    const rootDir = path.resolve(__dirname, "../../..");
    sidecarProcess = spawn("pnpm", ["--filter", "@openlinear/sidecar", "start"], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    sidecarProcess = spawn(binaryPath, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  sidecarPort = port;

  const apiUrl = `http://127.0.0.1:${port}`;
  const healthUrl = `${apiUrl}/health`;

  sidecarProcess.stdout?.on("data", (data: Buffer) => {
    emit("sidecar:output", { stream: "stdout", data: data.toString("utf-8") });
  });

  sidecarProcess.stderr?.on("data", (data: Buffer) => {
    emit("sidecar:output", { stream: "stderr", data: data.toString("utf-8") });
  });

  sidecarProcess.on("exit", (code, signal) => {
    emit("sidecar:exit", { code, signal });
    sidecarProcess = null;
    sidecarPort = null;
  });

  sidecarProcess.on("error", (err) => {
    emit("sidecar:output", {
      stream: "stderr",
      data: `Failed to start sidecar: ${err.message}`,
    });
  });

  emit("sidecar:ready", { port, api_url: apiUrl, health_url: healthUrl });
  return port;
}

export function shutdownSidecar(): void {
  if (!sidecarProcess) return;

  try {
    sidecarProcess.kill("SIGTERM");
    setTimeout(() => {
      if (sidecarProcess && !sidecarProcess.killed) {
        sidecarProcess.kill("SIGKILL");
      }
    }, 500);
  } catch {
  }

  sidecarProcess = null;
  sidecarPort = null;
}

function isPackaged(): boolean {
  return app.isPackaged;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
