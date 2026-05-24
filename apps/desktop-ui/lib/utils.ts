import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export async function openExternal(url: string): Promise<void> {
  try {
    if (typeof window !== 'undefined' && 'electronAPI' in window && window.electronAPI?.isElectron) {
      await window.electronAPI.openExternal(url);
      return;
    }
    const { open } = await import("@tauri-apps/plugin-shell")
    await open(url)
  } catch {
    window.open(url, "_blank")
  }
}
