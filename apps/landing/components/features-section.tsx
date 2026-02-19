export function FeaturesSection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-[#0a0f1a]" />
      
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] lg:text-[4rem] font-bold tracking-[-0.02em] text-white leading-[1.1]">
            Built for every AI agent
          </h2>
          <p className="mt-6 text-lg text-white/50 max-w-3xl mx-auto leading-relaxed">
            OpenLinear delivers a scalable, plug-and-play task execution infrastructure that 
            adapts to any codebase. Deploy anywhere, self-host securely and scale to handle 
            thousands of tasks with zero compromise on speed or reliability.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <FeatureCard
            icon={
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            }
            title="In-built connectors"
            description="OpenLinear syncs with GitHub repositories and integrates with your existing workflow via custom webhooks and APIs."
            link="Read about connectors in docs →"
          />

          <FeatureCard
            icon={
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none">
                <path d="M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" strokeWidth="2"/>
                <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            }
            title="Hybrid AI Execution"
            description="OpenLinear provides both manual task management and AI-powered execution, reducing developer overhead and controlling code quality."
            link="Read about AI execution in docs →"
          />

          <FeatureCard
            icon={
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
              </svg>
            }
            title="Persistent task tracking"
            description="Enable extremely long-running projects, so your team remembers context, past actions and project history across sprints."
            link="Read about task tracking in docs →"
          />
        </div>
      </div>
    </section>
  )
}

function FeatureCard({ 
  icon, 
  title, 
  description, 
  link 
}: { 
  icon: React.ReactNode
  title: string
  description: string
  link: string
}) {
  return (
    <div className="group relative rounded-3xl bg-white/[0.02] border border-white/[0.06] p-8 hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-500">
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-b from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      
      <div className="relative">
        <div className="h-14 w-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-6">
          {icon}
        </div>

        <h3 className="text-xl font-semibold text-white mb-3">{title}</h3>
        
        <p className="text-white/50 leading-relaxed mb-6">{description}</p>

        <a 
          href="/docs" 
          className="inline-flex items-center text-blue-400 hover:text-blue-300 transition-colors text-sm"
        >
          {link}
        </a>
      </div>
    </div>
  )
}
