import { ArrowRight } from "lucide-react"

export function CTASection() {
  return (
    <section className="relative py-40 md:py-52 overflow-hidden bg-background">
      {/* Barely perceptible ambient glow */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[350px] rounded-full bg-[hsl(235_18%_94%/0.2)] blur-[160px] pointer-events-none" />

      {/* Top divider */}
      <div className="absolute top-0 left-0 right-0 section-divider" />

      <div className="relative mx-auto max-w-[76rem] px-6 lg:px-10">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-14">
          <div className="max-w-xl">
            <h2 className="font-display text-[2.25rem] md:text-[3rem] lg:text-[3.75rem] font-bold tracking-[-0.05em] text-foreground text-balance leading-[1.02]">
              The board that ships.
            </h2>
          </div>
          <a
            href="#"
            className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-8 py-3.5 text-[0.875rem] font-medium text-primary-foreground whitespace-nowrap h-fit"
          >
            Download OpenLinear <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </section>
  )
}
