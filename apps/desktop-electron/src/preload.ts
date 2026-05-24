import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

export interface AuthCallbackResult {
  success: boolean;
  token?: string;
  error?: string;
}

export interface SidecarOutput {
  stream: string;
  data: string;
}

export interface SidecarExit {
  code: number | null;
  signal: string | null;
}

export interface SidecarReady {
  port: number;
  api_url: string;
  health_url: string;
}

export interface OpenCodeStatus {
  found: boolean;
  version: string | null;
  path: string | null;
}

export interface PlatformInfo {
  os: string;
  arch: string;
}

function wrapHandler<T>(
  eventName: string,
  callback: (payload: T) => void
): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(eventName, handler);
  return () => {
    ipcRenderer.removeListener(eventName, handler);
  };
}

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,

  invoke: (command: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(command, args),

  onSidecarReady: (callback: (payload: SidecarReady) => void) =>
    wrapHandler("sidecar:ready", callback),

  onSidecarOutput: (callback: (payload: SidecarOutput) => void) =>
    wrapHandler("sidecar:output", callback),

  onSidecarExit: (callback: (payload: SidecarExit) => void) =>
    wrapHandler("sidecar:exit", callback),

  onAuthCallback: (callback: (payload: AuthCallbackResult) => void) =>
    wrapHandler("auth:callback", callback),

  platform: (): Promise<string> => ipcRenderer.invoke("get-platform"),
  arch: (): Promise<string> => ipcRenderer.invoke("get-arch"),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("open-external", url),

  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("pick-folder"),

  storeLoad: (filename: string): Promise<void> =>
    ipcRenderer.invoke("store-load", filename),
  storeGet: (filename: string, key: string): Promise<unknown> =>
    ipcRenderer.invoke("store-get", filename, key),
  storeSet: (filename: string, key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke("store-set", filename, key, value),
  storeSave: (filename: string): Promise<void> =>
    ipcRenderer.invoke("store-save", filename),
});
