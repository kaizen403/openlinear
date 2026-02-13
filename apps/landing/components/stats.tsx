import { Check } from 'lucide-react'
import MotionWrapper from './motion-wrapper'

const stats = [
  {
    figure: 'Fig 1.',
    value: '4',
    label: 'Execution Modes',
    description: 'Single, parallel, queue, batch',
  },
  {
    figure: 'Fig 2.',
    value: '7+',
    label: 'Integrated Features',
    description: 'Board, execution, brainstorm, teams, inbox, god mode, settings',
  },
  {
    figure: 'Fig 3.',
    value: '100%',
    label: 'Open Source',
    description: 'MIT licensed, fully transparent',
  },
]

export default function Stats() {
  return (
    <section className="py-20 md:py-28 border-t border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <MotionWrapper className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 mb-6">
            <Check className="w-5 h-5 text-green-400" />
          </div>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground">
            The kanban board that codes for you
          </h2>
          <p className="mt-4 text-muted-foreground max-w-2xl mx-auto leading-7">
            Built for developers and small teams who think in issues and want AI to implement them.
            KazCode handles the full lifecycle from task creation to pull request.
          </p>
        </MotionWrapper>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {stats.map((stat, index) => (
            <MotionWrapper key={stat.label} delay={0.1 * (index + 1)}>
              <div className="p-6 border-b border-border text-center">
                <div className="text-xs text-muted-foreground uppercase tracking-wider mb-4">
                  {stat.figure}
                </div>
                <div className="text-4xl md:text-5xl font-bold text-foreground mb-2">
                  {stat.value}
                </div>
                <div className="text-sm font-medium text-foreground mb-1">
                  {stat.label}
                </div>
                <div className="text-sm text-muted-foreground">
                  {stat.description}
                </div>
              </div>
            </MotionWrapper>
          ))}
        </div>
      </div>
    </section>
  )
}
