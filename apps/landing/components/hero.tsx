'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import MotionWrapper from './motion-wrapper'
import JellyLogo from './jelly-logo'

type InstallTab = 'brew' | 'curl' | 'appimage'

const installCommands: Record<InstallTab, string> = {
  brew: 'brew install kazcode',
  curl: 'curl -fsSL https://kazcode.dev/install | bash',
  appimage: 'wget https://github.com/kaizen403/openlinear/releases/latest',
}

export default function Hero() {
  const [activeTab, setActiveTab] = useState<InstallTab>('curl')
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(installCommands[activeTab])
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="py-20 md:py-28">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <MotionWrapper className="text-center">
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tighter text-foreground">
            The kanban board
            <br />
            that codes for you
          </h1>

          <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
            Create tasks, hit execute, and AI agents clone your repo, write code, and open pull requests.
            Like Linear, but the tasks actually get done.
          </p>
        </MotionWrapper>

        <MotionWrapper delay={0.2} className="mt-10 max-w-xl mx-auto">
          <div className="flex items-center justify-center gap-1 p-1 rounded-full border border-border bg-card/50 w-fit mx-auto">
            {(['brew', 'curl', 'appimage'] as InstallTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-all ${
                  activeTab === tab
                    ? 'bg-white/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="mt-4 relative">
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-code border border-border font-mono text-sm text-foreground overflow-x-auto">
              <code className="flex-1 whitespace-nowrap">{installCommands[activeTab]}</code>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 p-1.5 rounded-md hover:bg-white/10 transition-colors"
                aria-label="Copy command"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-400" />
                ) : (
                  <Copy className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            </div>
          </div>
        </MotionWrapper>

        <MotionWrapper delay={0.4} className="mt-12">
          <div className="relative mx-auto max-w-4xl">
            <div className="absolute -inset-1 bg-gradient-to-r from-blue-500 via-purple-500 to-blue-500 rounded-2xl opacity-10 blur-xl animate-pulse"></div>
            <div className="relative aspect-video rounded-xl bg-code border border-border overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent"></div>
              <JellyLogo />
            </div>
          </div>
        </MotionWrapper>
      </div>
    </section>
  )
}
