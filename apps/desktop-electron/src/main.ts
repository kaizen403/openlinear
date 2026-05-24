import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  protocol,
} from "electron";
import * as path from "node:path";
import {
  launchSidecar,
  shutdownSidecar,
  getSidecarPort,
  SidecarReady,
  SidecarOutput,
  SidecarExit,
} from "./sidecar";

const isDev = process.argv.includes("--dev");
const gotTheLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let pendingAuthCallback: {
  success: boolean;
  token?: string;
  error?: string;
} | null = null;

function getFrontendPath(): string {
  if (isDev) {
    return "http://127.0.0.1:3000";
  }
  return path.join(__dirname, "../frontend/index.html");
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    center: true,
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  const frontendPath = getFrontendPath();
  if (frontendPath.startsWith("http")) {
    win.loadURL(frontendPath);
  } else {
    win.loadFile(frontendPath);
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
    mainWindow = createWindow();
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

  mainWindow = createWindow();

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
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    shutdownSidecar();
    app.quit();
  }
});

app.on("before-quit", () => {
  shutdownSidecar();
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
  const fs = await import("node:fs/promises");
  const storePath = path.join(app.getPath("userData"), filename);
  try {
    const data = await fs.readFile(storePath, "utf-8");
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
  const fs = await import("node:fs/promises");
  const store = storeCache.get(filename);
  if (!store) return;
  const storePath = path.join(app.getPath("userData"), filename);
  const data = Object.fromEntries(store.entries());
  await fs.writeFile(storePath, JSON.stringify(data, null, 2), "utf-8");
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
