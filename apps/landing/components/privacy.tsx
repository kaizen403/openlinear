import { Check, ArrowRight } from 'lucide-react'
import MotionWrapper from './motion-wrapper'

export default function Privacy() {
  return (
    <section className="py-16 md:py-24 border-t border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <MotionWrapper className="text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 mb-6">
            <Check className="w-5 h-5 text-green-400" />
          </div>
          
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground">
            Built for local control
          </h2>
          
          <p className="mt-4 text-muted-foreground max-w-2xl mx-auto">
            KazCode runs on your desktop with a local API sidecar. Your code stays on your machine — 
            each user gets an isolated Docker container for AI execution. No cloud dependency, 
            no data leaving your environment.
          </p>
          
          <a
            href="https://github.com/kaizen403/openlinear#architecture"
            className="inline-flex items-center gap-1.5 mt-6 text-sm font-medium text-foreground hover:underline"
          >
            Learn more about architecture
            <ArrowRight className="w-4 h-4" />
          </a>
        </MotionWrapper>
      </div>
    </section>
  )
}
