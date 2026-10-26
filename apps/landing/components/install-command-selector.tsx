"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"

type InstallMethod = "curl" | "npm" | "bun" | "brew" | "paru"

const installCommands: Record<InstallMethod, string> = {
  curl: "curl -fsSL https://rixie.in/api/install | bash",
  npm: "npm install -g openlinear",
  bun: "bun install -g openlinear",
  brew: "brew install openlinear",
  paru: "paru -S openlinear-bin",
}

export function InstallCommandSelector() {
  const [activeMethod, setActiveMethod] = useState<InstallMethod>("curl")
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(installCommands[activeMethod])
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const methods: InstallMethod[] = ["curl", "npm", "bun", "brew", "paru"]

  return (
    <div className="animate-fade-up-delay-4 w-full max-w-[640px]">
      <div className="glass-panel rounded-xl overflow-hidden">
        <div className="flex border-b border-border/50">
          {methods.map((method) => (
            <button
              type="button"
              key={method}
              onClick={() => setActiveMethod(method)}
              className={`
                relative px-4 py-3 text-[14px] font-medium transition-colors duration-200
                ${activeMethod === method 
                  ? "text-foreground" 
                  : "text-muted-foreground hover:text-foreground/80"
                }
              `}
            >
              {method}
              {activeMethod === method && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground" />
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between px-4 py-4 bg-secondary/30">
          <code className="text-[14px] font-mono text-foreground/90 truncate mr-4">
            {installCommands[activeMethod]}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="flex-shrink-0 p-2 rounded-md transition-all duration-200 hover:bg-white/5 group"
            aria-label={copied ? "Copied!" : "Copy command"}
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-400" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
