import { AnimatedTitle } from "@/components/animated-title"
import { InstallCommandSelector } from "@/components/install-command-selector"

export function Hero() {
  return (
    <section className="px-6 md:px-20 pt-24 md:pt-24 pb-24 md:pb-24">
      <div className="mx-auto max-w-content">
        <div className="animate-fade-up-delay-1 mb-8">
          <a
            href="https://github.com/kaizen403/openlinear/releases"
            className="inline-flex items-center gap-3 px-4 py-2 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all duration-200 group"
          >
            <span className="px-2 py-0.5 text-[12px] font-medium text-foreground border border-border rounded-md">New</span>
            <span className="text-[14px] text-muted-foreground group-hover:text-foreground transition-colors">
              Desktop app available in beta on macOS, Windows, and Linux.
            </span>
            <span className="text-[14px] text-foreground">Download now →</span>
          </a>
        </div>

        <div className="mb-10">
          <AnimatedTitle
            text="Execute your tasks."
            className="text-[28px] sm:text-[36px] md:text-[48px] lg:text-[64px] font-semibold tracking-[-0.5px] md:tracking-[-1px] leading-[1.15]"
          />
          <AnimatedTitle
            text="Don't just track them."
            className="text-[28px] sm:text-[36px] md:text-[48px] lg:text-[64px] font-semibold tracking-[-0.5px] md:tracking-[-1px] leading-[1.15]"
          />
        </div>

        <InstallCommandSelector />
      </div>
    </section>
  )
}
