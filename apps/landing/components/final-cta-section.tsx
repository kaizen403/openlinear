export function FinalCTASection() {
  return (
    <section className="py-12 px-8">
      <div className="mx-auto max-w-content">
        <h2 className="text-[14px] font-semibold leading-[20px] mb-2">
          We built OpenLinear because we needed it.
        </h2>
        <p className="text-[14px] text-muted-foreground leading-[20px] mb-6">
          We think you&apos;ll like it as much as we do.
        </p>
        <a
          href="https://github.com/kaizen403/openlinear/releases"
          className="group relative inline-flex items-center rounded-md bg-white px-3 py-4 text-[14px] font-medium text-black
            transition-all duration-300 ease-out
            hover:bg-white/90 hover:scale-[1.03] hover:shadow-[0_0_24px_rgba(255,255,255,0.3)]
            active:scale-[0.97] active:transition-transform active:duration-100
            focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-background
            overflow-hidden"
        >
          <span className="relative z-10 flex items-center gap-2">
            Download OpenLinear
            <svg
              className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </span>
          <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-out bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        </a>
      </div>
    </section>
  )
}
