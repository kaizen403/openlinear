export {};

declare global {
  interface SidecarReady {
    port: number;
    api_url: string;
    health_url: string;
  }

  interface SidecarOutput {
    stream: string;
    data: string;
  }

  interface SidecarExit {
    code: number | null;
    signal: string | null;
  }

  interface AuthCallbackResult {
    success: boolean;
    token?: string;
    error?: string;
  }

  interface OpenCodeStatus {
    found: boolean;
    version: string | null;
    path: string | null;
  }

  interface ElectronAPI {
    isElectron: true;
    invoke: (command: string, args?: unknown) => Promise<unknown>;
    onSidecarReady: (callback: (payload: SidecarReady) => void) => () => void;
    onSidecarOutput: (callback: (payload: SidecarOutput) => void) => () => void;
    onSidecarExit: (callback: (payload: SidecarExit) => void) => () => void;
    onAuthCallback: (callback: (payload: AuthCallbackResult) => void) => () => void;
    platform: () => Promise<string>;
    arch: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    pickFolder: () => Promise<string | null>;
    storeLoad: (filename: string) => Promise<void>;
    storeGet: (filename: string, key: string) => Promise<unknown>;
    storeSet: (filename: string, key: string, value: unknown) => Promise<void>;
    storeSave: (filename: string) => Promise<void>;
  }

  interface Window {
    electronAPI: ElectronAPI;
  }
}
