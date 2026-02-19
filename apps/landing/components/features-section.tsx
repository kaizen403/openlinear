export function FeaturesSection() {
  return (
    <section className="relative py-24 overflow-hidden bg-[#0a0f1a]">
      <div className="relative mx-auto max-w-[1200px] px-4">
        <div className="text-center mb-16">
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-tight text-white mb-4">
            Built for every AI agent
          </h2>
          <p className="text-white/50 text-[17px] max-w-2xl mx-auto leading-relaxed">
            OpenLinear delivers a scalable, plug-and-play memory infrastructure that
            adapts to any stack. Deploy anywhere, self-host securely and scale to
            billions of tokens with zero compromise on latency or compliance.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Card 1 */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.05),transparent_70%)]" />
              {/* Hexagon pattern bg */}
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'104\' viewBox=\'0 0 60 104\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M30 0L60 17.3205v34.641L30 69.282 0 51.9615V17.3205L30 0zm0 34.641L15 25.9808v17.3205L30 51.9615l15-8.6603V25.9808L30 34.641z\' fill=\'%23ffffff\' fill-opacity=\'0.1\' fill-rule=\'evenodd\'/%3E%3C/svg%3E")' }} />
              
              {/* Visual Nodes */}
              <div className="relative w-full h-full flex items-center justify-center">
                <div className="absolute top-1/4 left-1/4 h-12 w-12 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center backdrop-blur-md z-10">
                  <div className="h-6 w-6 bg-green-500 rounded" />
                </div>
                <div className="absolute bottom-1/4 left-1/4 h-12 w-12 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center backdrop-blur-md z-10">
                  <div className="h-6 w-6 bg-white rounded" />
                </div>
                <div className="absolute top-1/3 right-1/4 h-12 w-12 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center backdrop-blur-md z-10">
                  <span className="text-white/60 font-mono text-sm">&lt;/&gt;</span>
                </div>
                <div className="absolute bottom-1/3 right-1/4 h-12 w-12 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center backdrop-blur-md z-10">
                  <div className="h-6 w-6 bg-blue-500 rounded-full" />
                </div>
                
                {/* Center Logo */}
                <div className="h-20 w-20 text-cyan-400 z-20 group-hover:scale-110 transition-transform duration-500 drop-shadow-[0_0_15px_rgba(34,211,238,0.5)]">
                  <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor">
                    <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
                  </svg>
                </div>
                
                {/* Connecting Lines */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20" stroke="currentColor" strokeWidth="1">
                  <line x1="35%" y1="35%" x2="50%" y2="50%" />
                  <line x1="35%" y1="65%" x2="50%" y2="50%" />
                  <line x1="65%" y1="40%" x2="50%" y2="50%" />
                  <line x1="65%" y1="60%" x2="50%" y2="50%" />
                </svg>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">In-built connectors</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-6">
                OpenLinear syncs documents from Google Drive, Notion and OneDrive or via custom integrations.
              </p>
              <a href="#" className="text-blue-500 hover:text-blue-400 transition-colors text-[15px] font-medium">
                Read about connectors in docs →
              </a>
            </div>
          </div>

          {/* Card 2 */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex flex-col items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,rgba(59,130,246,0.1),transparent_60%)]" />
              
              <div className="flex justify-between w-full px-8 mt-4">
                <div className="bg-white/[0.03] border border-white/10 rounded-xl p-3 w-[110px]">
                  <div className="text-[10px] text-white/40 mb-2">Query</div>
                  <div className="space-y-1">
                    <div className="h-1.5 w-full bg-white/10 rounded-full" />
                    <div className="h-1.5 w-3/4 bg-white/10 rounded-full" />
                    <div className="h-1.5 w-5/6 bg-white/10 rounded-full" />
                  </div>
                  <div className="mt-4 flex justify-center">
                    <span className="px-3 py-1 rounded-full bg-blue-600/20 text-blue-400 text-xs border border-blue-500/30">Memory</span>
                  </div>
                </div>
                <div className="bg-white/[0.03] border border-white/10 rounded-xl p-3 w-[110px]">
                  <div className="text-[10px] text-white/40 mb-2">Query</div>
                  <div className="space-y-1">
                    <div className="h-1.5 w-5/6 bg-white/10 rounded-full" />
                    <div className="h-1.5 w-full bg-white/10 rounded-full" />
                    <div className="h-1.5 w-2/3 bg-white/10 rounded-full" />
                  </div>
                  <div className="mt-4 flex justify-center">
                    <span className="px-3 py-1 rounded-full bg-blue-600/20 text-blue-400 text-xs border border-blue-500/30">RAG</span>
                  </div>
                </div>
              </div>
              
              <div className="mt-8 relative">
                <svg className="absolute -top-12 left-1/2 -translate-x-1/2 w-48 h-16 pointer-events-none opacity-40 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M40 0 C40 30, 96 30, 96 60 M152 0 C152 30, 96 30, 96 60 M60 0 C60 30, 96 30, 96 60 M132 0 C132 30, 96 30, 96 60" />
                </svg>
                <div className="h-16 w-16 bg-[#0f1420] border border-white/10 rounded-2xl flex items-center justify-center relative z-10 shadow-[0_0_30px_rgba(59,130,246,0.2)]">
                  <div className="h-8 w-8 text-cyan-400">
                    <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor">
                      <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Hybrid Memory and RAG</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-6">
                OpenLinear provides both memory and RAG, reduce latency and control data inclusion.
              </p>
              <a href="#" className="text-blue-500 hover:text-blue-400 transition-colors text-[15px] font-medium">
                Read about memory vs RAG in docs →
              </a>
            </div>
          </div>

          {/* Card 3 */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(6,182,212,0.1),transparent_60%)]" />
              {/* Hexagon pattern bg */}
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'104\' viewBox=\'0 0 60 104\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M30 0L60 17.3205v34.641L30 69.282 0 51.9615V17.3205L30 0zm0 34.641L15 25.9808v17.3205L30 51.9615l15-8.6603V25.9808L30 34.641z\' fill=\'%23ffffff\' fill-opacity=\'0.1\' fill-rule=\'evenodd\'/%3E%3C/svg%3E")' }} />
              
              <div className="relative flex items-center justify-center">
                <div className="absolute h-40 w-40 border border-cyan-500/20 rounded-full animate-[spin_15s_linear_infinite]" />
                <div className="absolute h-56 w-56 border border-blue-500/10 rounded-full animate-[spin_20s_linear_infinite_reverse]" />
                
                {/* User Icon */}
                <div className="h-20 w-20 text-cyan-400 drop-shadow-[0_0_20px_rgba(34,211,238,0.6)] relative z-10">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                </div>

                <div className="absolute -top-12 text-[10px] text-white/40 bg-white/5 px-2 py-0.5 rounded border border-white/10">[education]</div>
                <div className="absolute -bottom-10 text-[10px] text-white/40 bg-white/5 px-2 py-0.5 rounded border border-white/10">[preferences]</div>
                <div className="absolute -left-16 text-[10px] text-white/40 bg-white/5 px-2 py-0.5 rounded border border-white/10">[user_name]</div>
                <div className="absolute -right-16 text-[10px] text-white/40 bg-white/5 px-2 py-0.5 rounded border border-white/10">[job_profile]</div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Persistent user profiles</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-6">
                Enable extremely long-running agents, so your agent remembers roles, past actions and user preferences.
              </p>
              <a href="#" className="text-blue-500 hover:text-blue-400 transition-colors text-[15px] font-medium">
                Read about user profiles in docs →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
