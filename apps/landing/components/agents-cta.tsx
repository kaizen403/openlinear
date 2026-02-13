import { ArrowRight } from 'lucide-react'
import MotionWrapper from './motion-wrapper'

export default function AgentsCTA() {
  return (
    <section className="py-20 md:py-28 border-t border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <MotionWrapper className="text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground">
            Multiple AI agents at your command
          </h2>

          <p className="mt-4 text-muted-foreground max-w-2xl mx-auto leading-7">
            KazCode's agent layer is designed for flexibility. Start with OpenCode today, 
            and seamlessly switch to Claude Code, Codex, or Aider as they become available. 
            Each agent runs in an isolated Docker container with its own workspace.
          </p>
          
          <a
            href="https://github.com/kaizen403/openlinear#agent-integration"
            className="inline-flex items-center gap-1.5 mt-6 text-sm font-medium text-foreground hover:underline"
          >
            View agent integration docs
            <ArrowRight className="w-4 h-4" />
          </a>
        </MotionWrapper>
      </div>
    </section>
  )
}
