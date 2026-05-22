import { Github, GitBranch, Layers, Workflow, ArrowRight } from "lucide-react"

export function IntegrationsSection() {
  return (
    <section className="relative py-24 overflow-hidden bg-[#0a0f1a]">
      <div className="relative mx-auto max-w-[1200px] px-4">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Visual Left Side */}
          <div className="relative h-[400px] flex items-center justify-center">
            {/* Connecting lines */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20 text-white" stroke="currentColor" strokeWidth="1.5">
              <line x1="50%" y1="50%" x2="20%" y2="20%" />
              <line x1="50%" y1="50%" x2="30%" y2="15%" />
              <line x1="50%" y1="50%" x2="50%" y2="10%" />
              <line x1="50%" y1="50%" x2="80%" y2="30%" />
              <line x1="50%" y1="50%" x2="85%" y2="65%" />
              <line x1="50%" y1="50%" x2="60%" y2="85%" />
              <line x1="50%" y1="50%" x2="30%" y2="85%" />
              <line x1="50%" y1="50%" x2="15%" y2="60%" />
            </svg>

            {/* Center Logo */}
            <div className="h-32 w-32 text-cyan-400 z-20 drop-shadow-[0_0_30px_rgba(34,211,238,0.4)]">
              <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor">
                <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
              </svg>
            </div>

            {/* Orbiting Icons */}
            <IntegrationNode icon={Github} top="20%" left="20%" />
            <IntegrationNode text="GPT" top="15%" left="35%" color="bg-emerald-400" />
            <IntegrationNode text="C" top="10%" left="55%" color="bg-orange-400" />
            <IntegrationNode text="MCP" top="25%" left="75%" color="bg-violet-400" />
            <IntegrationNode text="OC" top="30%" left="80%" color="bg-cyan-400" />
            <IntegrationNode text="aws" top="65%" left="85%" />
            <IntegrationNode text="Py" top="85%" left="60%" color="bg-yellow-500" />
            <IntegrationNode icon={GitBranch} top="85%" left="30%" />
            <IntegrationNode text="JS" top="60%" left="15%" color="bg-yellow-400" />
          </div>

          {/* Text Right Side */}
          <div className="lg:pl-12">
            <div className="inline-block px-3 py-1 rounded-md bg-white/[0.03] border border-white/[0.08] text-[13px] text-white/60 mb-6">
              Connectors and Integrations
            </div>
            
            <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-tight text-white leading-[1.1] mb-6">
              Connect your repo. Pick your model. Ship.
            </h2>
            
            <p className="text-[17px] text-white/50 leading-relaxed mb-8">
              GitHub OAuth for repo access and PR creation. MCP server for any AI agent to plan projects, create phases, and ship tasks directly into your board. OpenAI, Anthropic, and local LLMs via the OpenCode SDK. Bring your own API keys, run agents on your machine.
              <br /><br />
              No proxy in the middle. No data leaves your stack unless you say so.
            </p>

            <div className="flex flex-wrap gap-3">
              <a
                href="/docs"
                className="inline-flex items-center px-6 py-3 rounded-full bg-transparent border border-white/20 text-white hover:bg-white/[0.03] hover:border-white/30 transition-all text-sm font-medium"
              >
                Read more about connectors →
              </a>
              <a
                href="https://docs.openlinear.tech/integrations/mcp"
                className="inline-flex items-center px-6 py-3 rounded-full bg-violet-500/10 border border-violet-500/30 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/50 transition-all text-sm font-medium"
              >
                MCP docs →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function IntegrationNode({ icon: Icon, text, top, left, color = "bg-white/[0.04]" }: any) {
  return (
    <div 
      className="absolute h-14 w-14 rounded-2xl bg-[#131823] border border-white/[0.08] flex items-center justify-center z-10 shadow-xl"
      style={{ top, left, transform: 'translate(-50%, -50%)' }}
    >
      {Icon ? (
        <Icon className="h-6 w-6 text-white/80" />
      ) : (
        <span className={`text-sm font-bold ${color === "bg-white/[0.04]" ? "text-white/80" : color.replace('bg-', 'text-')}`}>{text}</span>
      )}
    </div>
  )
}
