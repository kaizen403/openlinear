"use client"

import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-shell"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Terminal, Download, RefreshCw, ExternalLink } from "lucide-react"

interface OpencodeStatus {
  found: boolean
  version: string | null
  path: string | null
}

interface PlatformInfo {
  os: "macos" | "linux" | "windows" | "unknown"
  arch: "x86_64" | "aarch64" | "unknown"
}

const OPENCODE_RELEASES_URL = "https://github.com/opencode-ai/opencode/releases"

export function OpencodeSetupDialog({
  open: isOpen,
  onOpenChange,
  onComplete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete?: () => void
}) {
  const [status, setStatus] = React.useState<OpencodeStatus | null>(null)
  const [platform, setPlatform] = React.useState<PlatformInfo | null>(null)
  const [checking, setChecking] = React.useState(false)

  const checkOpencode = React.useCallback(async () => {
    setChecking(true)
    try {
      const result = await invoke<OpencodeStatus>("check_opencode")
      setStatus(result)
      if (result.found && onComplete) {
        onComplete()
      }
    } catch (error) {
      console.error("Failed to check OpenCode:", error)
      setStatus({ found: false, version: null, path: null })
    } finally {
      setChecking(false)
    }
  }, [onComplete])

  const detectPlatform = React.useCallback(async () => {
    try {
      // Dynamic import for Tauri plugins
      const { platform, arch } = await import("@tauri-apps/plugin-os")
      const os = await platform()
      const cpuArch = await arch()
      setPlatform({
        os: os as PlatformInfo["os"],
        arch: cpuArch as PlatformInfo["arch"],
      })
    } catch {
      // Not running in Tauri
      setPlatform({ os: "unknown", arch: "unknown" })
    }
  }, [])

  React.useEffect(() => {
    if (isOpen) {
      checkOpencode()
      detectPlatform()
    }
  }, [isOpen, checkOpencode, detectPlatform])

  const handleDownload = async () => {
    try {
      await open(OPENCODE_RELEASES_URL)
    } catch {
      // Fallback for non-Tauri environment
      window.open(OPENCODE_RELEASES_URL, "_blank")
    }
  }

  const getPlatformLabel = () => {
    if (!platform) return "Detecting..."
    const osLabels: Record<string, string> = {
      macos: "macOS",
      linux: "Linux",
      windows: "Windows",
      unknown: "Unknown OS",
    }
    const archLabels: Record<string, string> = {
      x86_64: "Intel/AMD 64-bit",
      aarch64: "ARM 64-bit (Apple Silicon)",
      unknown: "",
    }
    return `${osLabels[platform.os]} ${archLabels[platform.arch]}`.trim()
  }

  const getInstallInstructions = () => {
    if (!platform) return null

    if (platform.os === "macos") {
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Install via Homebrew (recommended):
          </p>
          <code className="block rounded bg-muted px-3 py-2 text-sm font-mono">
            brew install opencode-ai/tap/opencode
          </code>
          <p className="text-xs text-muted-foreground">
            Or download the binary from GitHub Releases.
          </p>
        </div>
      )
    }

    if (platform.os === "linux") {
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Download the Linux binary from GitHub Releases and add to your PATH:
          </p>
          <code className="block rounded bg-muted px-3 py-2 text-sm font-mono">
            chmod +x opencode && sudo mv opencode /usr/local/bin/
          </code>
        </div>
      )
    }

    return (
      <p className="text-sm text-muted-foreground">
        Download the appropriate binary for your platform from GitHub Releases.
      </p>
    )
  }

  if (status?.found) {
    return (
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-green-500" />
              OpenCode Ready
            </DialogTitle>
            <DialogDescription>
              OpenCode is installed and ready to use.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Version</span>
              <span className="font-mono">{status.version || "Unknown"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Path</span>
              <span className="font-mono text-xs truncate max-w-[200px]">
                {status.path || "Unknown"}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            OpenCode Required
          </DialogTitle>
          <DialogDescription>
            OpenLinear requires OpenCode to execute AI-powered tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <span className="text-sm font-medium">Your Platform</span>
            <span className="text-sm text-muted-foreground">
              {getPlatformLabel()}
            </span>
          </div>

          {getInstallInstructions()}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={checkOpencode}
            disabled={checking}
            className="w-full sm:w-auto"
          >
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
            Check Again
          </Button>
          <Button onClick={handleDownload} className="w-full sm:w-auto">
            <Download className="h-4 w-4" />
            Download
            <ExternalLink className="h-3 w-3 ml-1" />
          </Button>
        </DialogFooter>

        <div className="text-center">
          <button
            onClick={() => onOpenChange(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Skip for now
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
