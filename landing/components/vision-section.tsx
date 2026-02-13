import { ArrowRight } from "lucide-react"

export function VisionSection() {
  return (
    <section className="relative py-40 md:py-52 overflow-hidden">
      {/* Deep quiet dark */}
      <div className="absolute inset-0 bg-[hsl(230_25%_8%)]" />

      {/* Single atmospheric glow - very restrained */}
      <div className="absolute top-0 right-0 w-3/4 h-full bg-[radial-gradient(ellipse_60%_70%_at_80%_25%,hsl(240_20%_12%/0.4),transparent_65%)]" />

      {/* Faint horizon line at top */}
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(0_0%_100%/0.04)] to-transparent" />

      <div className="relative mx-auto max-w-[76rem] px-6 lg:px-10">
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-28 items-center">
          {/* Left - quiet brand presence */}
          <div className="hidden lg:flex items-center justify-center">
            <div className="relative w-64 h-64">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,hsl(243_30%_50%/0.04),transparent_70%)]" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-display text-7xl font-bold text-[hsl(0_0%_100%/0.02)] tracking-[-0.05em] select-none">
                  OL
                </span>
              </div>
            </div>
          </div>

          {/* Right - editorial copy */}
          <div className="flex flex-col gap-8">
            <h2 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-[hsl(0_0%_95%)] text-balance leading-[1.04]">
              Open by design.
            </h2>
            <p className="text-[hsl(228_10%_45%)] leading-[1.75] text-[0.9375rem] tracking-[-0.01em] max-w-lg">
              OpenLinear is built to work with multiple AI agents. Execution happens transparently. Your repository stays under your control.
            </p>
            <a
              href="#"
              className="inline-flex items-center gap-2.5 rounded-full border border-[hsl(0_0%_100%/0.06)] px-7 py-3 text-[0.8125rem] font-medium text-[hsl(0_0%_80%)] transition-all duration-[300ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] hover:bg-[hsl(0_0%_100%/0.03)] hover:border-[hsl(0_0%_100%/0.1)] w-fit"
            >
              View source on GitHub <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
