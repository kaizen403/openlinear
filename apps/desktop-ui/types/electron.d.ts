export {}

declare global {
  interface Window {
    electronAPI?: {
      isElectron: true;
      invoke: (command: string, args?: unknown) => Promise<unknown>;
      onSidecarReady: (callback: (payload: { port: number; api_url: string; health_url: string }) => void) => () => void;
      onSidecarOutput: (callback: (payload: { stream: string; data: string }) => void) => () => void;
      onSidecarExit: (callback: (payload: { code: number | null; signal: string | null }) => void) => () => void;
      onAuthCallback: (callback: (payload: { success: boolean; token?: string; error?: string }) => void) => () => void;
      platform: () => Promise<string>;
      arch: () => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      pickFolder: () => Promise<string | null>;
      storeLoad: (filename: string) => Promise<void>;
      storeGet: (filename: string, key: string) => Promise<unknown>;
      storeSet: (filename: string, key: string, value: unknown) => Promise<void>;
      storeSave: (filename: string) => Promise<void>;
    };
  }
}
