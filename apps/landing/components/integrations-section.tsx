import { Github, GitBranch, Layers, Workflow, ArrowRight } from "lucide-react"

export function IntegrationsSection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0f1a] via-[#0d1424] to-[#0a0f1a]" />
      
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full bg-blue-500/5 blur-[150px] pointer-events-none" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div className="relative">
            <div className="relative flex items-center justify-center">
              <div className="relative">
                <div className="absolute inset-0 bg-blue-500/20 blur-[100px] rounded-full" />
                
                <div className="relative h-64 w-64 rounded-3xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30 flex items-center justify-center">
                  <svg 
                    viewBox="0 0 100 100" 
                    className="h-32 w-32 text-blue-400"
                    fill="currentColor"
                  >
                    <path d="M50 10 L90 30 L90 70 L50 90 L10 70 L10 30 Z" fill="none" stroke="currentColor" strokeWidth="4"/>
                    <circle cx="50" cy="50" r="15" fill="currentColor"/>
                    <path d="M50 10 L50 35" stroke="currentColor" strokeWidth="4"/>
                    <path d="M50 65 L50 90" stroke="currentColor" strokeWidth="4"/>
                    <path d="M90 30 L65 42" stroke="currentColor" strokeWidth="4"/>
                    <path d="M35 58 L10 70" stroke="currentColor" strokeWidth="4"/>
                    <path d="M90 70 L65 58" stroke="currentColor" strokeWidth="4"/>
                    <path d="M35 42 L10 30" stroke="currentColor" strokeWidth="4"/>
                  </svg>
                </div>

                <IntegrationOrb icon={Github} label="GitHub" position="top-0 -right-8" />
                <IntegrationOrb icon={GitBranch} label="Git" position="top-1/4 -left-8" />
                <IntegrationOrb icon={Layers} label="Projects" position="bottom-1/4 -right-8" />
                <IntegrationOrb icon={Workflow} label="CI/CD" position="bottom-0 left-1/4" />
              </div>
            </div>
          </div>

          <div className="text-center lg:text-left">
            <span className="inline-block px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 mb-6">
              Connectors and Integrations
            </span>
            
            <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-[-0.02em] text-white leading-[1.1] mb-6">
              Bring your code from
              <br />
              where it lives.
            </h2>
            
            <p className="text-lg text-white/50 leading-relaxed mb-8">
              OpenLinear connects to GitHub repositories and syncs with your development workflow. 
              Forget custom infrastructure. OpenLinear drops into your stack with just a few clicks.
            </p>

            <a
              href="/docs"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/[0.04] border border-white/[0.12] text-white hover:bg-white/[0.08] hover:border-white/[0.2] transition-all"
            >
              Read more about connectors
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

function IntegrationOrb({ 
  icon: Icon, 
  label, 
  position 
}: { 
  icon: React.ComponentType<{ className?: string }>
  label: string
  position: string
}) {
  return (
    <div className={`absolute ${position} flex flex-col items-center gap-2`}>
      <div className="h-14 w-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] transition-all">
        <Icon className="h-6 w-6" />
      </div>
      <span className="text-xs text-white/40">{label}</span>
    </div>
  )
}
