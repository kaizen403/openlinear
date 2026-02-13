import { Check, ArrowRight } from 'lucide-react'
import MotionWrapper from './motion-wrapper'

const features = [
  {
    title: 'Kanban board',
    description: 'Four-column board: Todo, In Progress, Done, Cancelled',
  },
  {
    title: 'AI task execution',
    description: 'Clone → branch → agent session → commit → PR',
  },
  {
    title: 'Batch execution',
    description: 'Run tasks in parallel or queue mode',
  },
  {
    title: 'AI brainstorm',
    description: 'Describe a goal, get structured tasks with priorities',
  },
  {
    title: 'GitHub integration',
    description: 'OAuth sign-in, repo import, automatic PR creation',
  },
  {
    title: 'Real-time updates',
    description: 'Live execution logs and status via SSE',
  },
  {
    title: 'Teams',
    description: 'Collaborate with invite codes and scoped issue numbering',
  },
]

export default function Features() {
  return (
    <section className="py-20 md:py-28 border-t border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-2 gap-12 md:gap-16">
          <MotionWrapper>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground">
              What is KazCode?
            </h2>
            <p className="mt-4 text-muted-foreground max-w-2xl mx-auto leading-7">
              KazCode is an open source desktop app that combines a Linear-style kanban board 
              with AI coding agents. Create tasks, organize them on a board, and execute them — 
              the AI clones your repo, creates a branch, writes code, and opens a pull request.
            </p>
            <a
              href="https://github.com/kaizen403/openlinear#readme"
              className="inline-flex items-center gap-1.5 mt-6 text-sm font-medium text-foreground hover:underline"
            >
              Read docs
              <ArrowRight className="w-4 h-4" />
            </a>
          </MotionWrapper>

          <MotionWrapper delay={0.15}>
            <div className="space-y-4">
              {features.map((feature) => (
                <div key={feature.title} className="flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center">
                      <Check className="w-3 h-3 text-green-400" />
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-foreground">{feature.title}</span>
                    <span className="text-muted-foreground"> — {feature.description}</span>
                  </div>
                </div>
              ))}
            </div>
          </MotionWrapper>
        </div>
      </div>
    </section>
  )
}
