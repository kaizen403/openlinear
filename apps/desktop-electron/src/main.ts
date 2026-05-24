import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
} from "electron";
import * as path from "node:path";
import * as http from "node:http";
import * as fs from "node:fs";
import * as net from "node:net";
import {
  launchSidecar,
  shutdownSidecar,
  getSidecarPort,
} from "./sidecar";

const isDev = process.argv.includes("--dev");
const gotTheLock = app.requestSingleInstanceLock();

if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}

let mainWindow: BrowserWindow | null = null;
let pendingAuthCallback: {
  success: boolean;
  token?: string;
  error?: string;
} | null = null;
let staticServer: http.Server | null = null;

function findFrontendDir(): string {
  const candidates = [
    path.join(__dirname, "../frontend"),
    path.join(__dirname, "../../desktop-ui/out"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  throw new Error(
    `Frontend build not found. Tried: ${candidates.join(", ")}. ` +
    `Run pnpm --filter @openlinear/desktop-ui build:electron first.`
  );
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object" && addr.port) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Failed to get ephemeral port")));
      }
    });
    srv.on("error", (err) => reject(err));
  });
}

async function startStaticServer(): Promise<number> {
  if (isDev) return 3000;
  const staticDir = findFrontendDir();
  const port = await pickFreePort();

  staticServer = http.createServer((req, res) => {
    const reqPath = decodeURIComponent(req.url || "/");
    let filePath = path.join(staticDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(staticDir, "index.html");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    staticServer!.listen(port, "127.0.0.1", () => {
      console.log(`[Static] Serving ${staticDir} on http://127.0.0.1:${port}`);
      resolve(port);
    });
    staticServer!.on("error", reject);
  });
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    center: true,
    show: false,
    backgroundColor: "#0a0a0a",
    frame: true,
    titleBarStyle: "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      offscreen: false,
    },
  });

  win.loadURL(url);

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
      console.log("[Window] Ready and shown");
    }
  });

  if (isDev) {
    win.webContents.openDevTools();
  }

  return win;
}

function emitToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function handleCallbackUrl(urlStr: string): void {
  const url = new URL(urlStr);
  if (url.hostname !== "callback" || (url.pathname !== "" && url.pathname !== "/")) {
    return;
  }

  const error = url.searchParams.get("error");
  const token = url.searchParams.get("token");

  if (error) {
    pendingAuthCallback = { success: false, error };
    emitToWindow("auth:callback", pendingAuthCallback);
  } else if (token) {
    pendingAuthCallback = { success: true, token };
    emitToWindow("auth:callback", pendingAuthCallback);
  } else {
    pendingAuthCallback = {
      success: false,
      error: "Missing 'token' parameter in callback URL",
    };
    emitToWindow("auth:callback", pendingAuthCallback);
  }

  focusMainWindow();
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith("openlinear://"));
    if (url) {
      handleCallbackUrl(url);
    }
    focusMainWindow();
  });
}

app.whenReady().then(async () => {
  if (process.platform === "linux") {
    app.setAsDefaultProtocolClient("openlinear");
  }

  const staticPort = await startStaticServer();
  const frontendUrl = isDev
    ? "http://127.0.0.1:3000"
    : `http://127.0.0.1:${staticPort}`;

  console.log(`[App] Loading frontend from ${frontendUrl}`);
  mainWindow = createWindow(frontendUrl);

  try {
    const port = await launchSidecar(emitToWindow);
    console.log(`[Sidecar] Started on port ${port}`);
  } catch (err) {
    console.error("[Sidecar] Failed to launch:", err);
  }

  const url = process.argv.find((arg) => arg.startsWith("openlinear://"));
  if (url) {
    handleCallbackUrl(url);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(frontendUrl);
    }
  });
});

app.on("window-all-closed", () => {
  if (staticServer) {
    staticServer.close();
    staticServer = null;
  }
  if (process.platform !== "darwin") {
    shutdownSidecar();
    app.quit();
  }
});

app.on("before-quit", () => {
  shutdownSidecar();
  if (staticServer) {
    staticServer.close();
    staticServer = null;
  }
});

app.on("open-url", (_event, url) => {
  if (url.startsWith("openlinear://")) {
    handleCallbackUrl(url);
  }
});

ipcMain.handle("start_api_server", async () => {
  const port = getSidecarPort();
  if (port) return port;
  return launchSidecar(emitToWindow);
});

ipcMain.handle("stop_api_server", async () => {
  shutdownSidecar();
});

ipcMain.handle("get_api_server_port", async () => {
  return getSidecarPort();
});

ipcMain.handle("check_opencode", async () => {
  const { execFileSync } = await import("node:child_process");
  const whichModule = await import("which");
  const whichSync = whichModule.sync || (whichModule.default as { sync: (cmd: string) => string }).sync;

  const bundledPath = path.join(
    process.resourcesPath ?? path.resolve(__dirname, "../../desktop/src-tauri/binaries"),
    `opencode-${process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : process.platform === "linux" ? "x86_64-unknown-linux-gnu" : "x86_64-pc-windows-msvc"}`
  );

  const candidates = [bundledPath];
  try {
    const systemPath = whichSync("opencode");
    candidates.push(systemPath);
  } catch {
  }

  for (const candidate of candidates) {
    try {
      const output = execFileSync(candidate, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return {
        found: true,
        version: output.trim() || null,
        path: candidate,
      };
    } catch {
    }
  }

  return { found: false, version: null, path: null };
});

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("open-external", async (_event, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle("get-platform", () => {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return "unknown";
});

ipcMain.handle("get-arch", () => {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x86_64";
  return "unknown";
});

const storeCache = new Map<string, Map<string, unknown>>();

ipcMain.handle("store-load", async (_event, filename: string) => {
  const fsPromises = await import("node:fs/promises");
  const storePath = path.join(app.getPath("userData"), filename);
  try {
    const data = await fsPromises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    storeCache.set(filename, new Map(Object.entries(parsed)));
  } catch {
    storeCache.set(filename, new Map());
  }
});

ipcMain.handle("store-get", async (_event, filename: string, key: string) => {
  const store = storeCache.get(filename);
  if (!store) {
    await ipcMain.emit("store-load", undefined as never, filename);
    return storeCache.get(filename)?.get(key);
  }
  return store.get(key);
});

ipcMain.handle(
  "store-set",
  async (_event, filename: string, key: string, value: unknown) => {
    let store = storeCache.get(filename);
    if (!store) {
      await ipcMain.emit("store-load", undefined as never, filename);
      store = storeCache.get(filename);
      if (!store) {
        store = new Map();
        storeCache.set(filename, store);
      }
    }
    store.set(key, value);
  }
);

ipcMain.handle("store-save", async (_event, filename: string) => {
  const fsPromises = await import("node:fs/promises");
  const store = storeCache.get(filename);
  if (!store) return;
  const storePath = path.join(app.getPath("userData"), filename);
  const data = Object.fromEntries(store.entries());
  await fsPromises.writeFile(storePath, JSON.stringify(data, null, 2), "utf-8");
});

ipcMain.handle("consume_pending_auth_callback", async () => {
  const result = pendingAuthCallback;
  pendingAuthCallback = null;
  return result;
});

ipcMain.handle("window-close", async () => {
  mainWindow?.close();
});

ipcMain.handle("window-minimize", async () => {
  mainWindow?.minimize();
});

ipcMain.handle("window-maximize", async () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle("window-is-fullscreen", async () => {
  return mainWindow?.isFullScreen() ?? false;
});

ipcMain.handle("window-set-fullscreen", async (_event, fullscreen: boolean) => {
  mainWindow?.setFullScreen(fullscreen);
});

ipcMain.handle("window-toggle-maximize", async () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
