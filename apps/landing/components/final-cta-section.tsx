import { ArrowRight, Github } from "lucide-react"

export function FinalCTASection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0f1a] to-[#0d1424]" />
      
      <div className="absolute inset-0">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-full bg-blue-500/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="font-display text-[2.5rem] md:text-[4rem] font-bold tracking-[-0.02em] text-white leading-[1.1] mb-6">
          Ready to ship faster?
        </h2>
        
        <p className="text-xl text-white/50 max-w-2xl mx-auto mb-10">
          Join thousands of developers who are already using OpenLinear to automate their workflow. Start free, no credit card required.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <a
            href="https://dashboard.rixie.in"
            className="group inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 text-white font-medium hover:from-blue-400 hover:to-blue-500 transition-all shadow-lg shadow-blue-500/25"
          >
            Get Started Free
            <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
          </a>
          
          <a
            href="https://github.com/kaizen403/openlinear"
            className="inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-white/[0.04] border border-white/[0.12] text-white font-medium hover:bg-white/[0.08] hover:border-white/[0.2] transition-all"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="h-5 w-5" />
            View on GitHub
          </a>
        </div>

        <p className="mt-8 text-sm text-white/30">
          Free forever for up to 100 tasks/month. No credit card required.
        </p>
      </div>
    </section>
  )
}
