export function ProductSuite() {
  return (
    <section className="relative py-32 md:py-40 bg-[hsl(228_14%_97.5%)]">
      <div className="absolute top-0 left-0 right-0 section-divider" />

      <div className="mx-auto max-w-[76rem] px-6 lg:px-10">
        {/* Header row */}
        <div className="mb-16">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            How it works
          </h2>
        </div>

        {/* Steps */}
        <div className="grid md:grid-cols-3 gap-10 lg:gap-16">
          <div>
            <p className="text-[0.75rem] font-semibold text-primary/60 mb-4 tracking-[-0.01em]">01</p>
            <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">Plan</h3>
            <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em]">
              Create tasks. Add labels. Set priorities.
            </p>
          </div>
          <div>
            <p className="text-[0.75rem] font-semibold text-primary/60 mb-4 tracking-[-0.01em]">02</p>
            <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">Execute</h3>
            <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em]">
              Run an AI agent that clones your repo, creates a branch, and implements the task.
            </p>
          </div>
          <div>
            <p className="text-[0.75rem] font-semibold text-primary/60 mb-4 tracking-[-0.01em]">03</p>
            <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">Review</h3>
            <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em]">
              Get a pull request. Approve, merge, ship.
            </p>
          </div>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 section-divider" />
    </section>
  )
}
