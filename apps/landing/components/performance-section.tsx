export function PerformanceSection() {
  return (
    <section className="relative py-24 overflow-hidden bg-[#0a0f1a]">
      <div className="relative mx-auto max-w-[1200px] px-4">
        <div className="text-center mb-16">
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-tight text-white leading-[1.1]">
            Best latency, quality, and cost.
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Card 1 */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[240px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex flex-col items-center justify-center p-6">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,rgba(59,130,246,0.15),transparent_60%)]" />
              
              <div className="w-full space-y-4 relative z-10">
                <div className="absolute -top-10 left-0 bg-white/[0.05] border border-white/10 px-3 py-1 rounded-md text-[11px] text-white/50">Recall time</div>
                
                {/* mem0 bar */}
                <div className="flex items-center gap-3">
                  <div className="h-10 w-[70%] bg-[#1a2133] rounded-lg border border-white/5 flex items-center px-4 gap-2">
                    <div className="h-4 w-4 bg-white/20 rounded-full" />
                    <span className="text-xs text-white/70">mem0</span>
                  </div>
                  <span className="text-xs text-white/50 font-mono">7-8s</span>
                </div>
                
                {/* zep bar */}
                <div className="flex items-center gap-3">
                  <div className="h-10 w-[45%] bg-[#1a2133] rounded-lg border border-white/5 flex items-center px-4 gap-2">
                    <div className="h-4 w-4 bg-white/20 rounded-sm" />
                    <span className="text-xs text-white/70">zep</span>
                  </div>
                  <span className="text-xs text-white/50 font-mono">4s</span>
                </div>
                
                {/* supermemory bar */}
                <div className="flex items-center gap-4 pt-2">
                  <div className="h-12 w-[35%] bg-gradient-to-r from-blue-500 to-cyan-400 rounded-lg flex items-center justify-center shadow-[0_0_20px_rgba(59,130,246,0.4)]">
                    <div className="flex flex-col items-center">
                       <svg viewBox="0 0 24 24" className="h-4 w-4 text-white mb-0.5" fill="currentColor">
                         <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
                       </svg>
                       <span className="text-[9px] text-white font-medium tracking-wide">supermemory</span>
                    </div>
                  </div>
                  <span className="text-2xl font-bold text-white font-mono tracking-tight">&lt;300 ms</span>
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Best-in-class recall time</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-2">
                OpenLinear retrieves memories in milliseconds — up to 10× faster than Zep and 25× faster than Mem0.
              </p>
            </div>
          </div>

          {/* Card 2 */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[240px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex items-center justify-center">
              {/* Hexagon pattern bg */}
              <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'104\' viewBox=\'0 0 60 104\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M30 0L60 17.3205v34.641L30 69.282 0 51.9615V17.3205L30 0zm0 34.641L15 25.9808v17.3205L30 51.9615l15-8.6603V25.9808L30 34.641z\' fill=\'%23ffffff\' fill-opacity=\'1\' fill-rule=\'evenodd\'/%3E%3C/svg%3E")' }} />
              
              <div className="relative w-full h-full flex items-center justify-center">
                <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20" stroke="currentColor" strokeWidth="1">
                  <line x1="20%" y1="20%" x2="50%" y2="50%" />
                  <line x1="20%" y1="50%" x2="50%" y2="50%" />
                  <line x1="20%" y1="80%" x2="50%" y2="50%" />
                  <line x1="80%" y1="20%" x2="50%" y2="50%" />
                  <line x1="80%" y1="50%" x2="50%" y2="50%" />
                  <line x1="80%" y1="80%" x2="50%" y2="50%" />
                  
                  {/* Concentric webs */}
                  <circle cx="50%" cy="50%" r="30%" fill="none" />
                  <circle cx="50%" cy="50%" r="45%" fill="none" />
                </svg>

                <div className="absolute left-[15%] top-[15%] h-8 w-8 text-white/20"><Hex /></div>
                <div className="absolute left-[10%] top-[45%] h-8 w-8 text-white/20"><Hex /></div>
                <div className="absolute left-[15%] bottom-[15%] h-8 w-8 text-white/20"><Hex /></div>
                <div className="absolute right-[15%] top-[15%] h-8 w-8 text-white/20"><Hex /></div>
                <div className="absolute right-[10%] top-[45%] h-8 w-8 text-white/20"><Hex /></div>
                <div className="absolute right-[15%] bottom-[15%] h-8 w-8 text-white/20"><Hex /></div>

                {/* Center Box */}
                <div className="h-20 w-20 bg-[#131823] border border-white/10 rounded-2xl flex flex-col items-center justify-center z-10 shadow-xl">
                  <svg viewBox="0 0 24 24" className="h-8 w-8 text-cyan-400 mb-1" fill="currentColor">
                    <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
                  </svg>
                  <span className="text-[8px] text-white/50 tracking-wider">openlinear™</span>
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Recall quality like the human brain</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-2">
                We built OpenLinear like the human brain - with forgetfulness, updates and human-like understanding of events and data.
              </p>
            </div>
          </div>

          {/* Card 3 */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[240px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex flex-col items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(59,130,246,0.4),transparent_60%)]" />
              <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-blue-500/20 to-transparent" />
              
              <div className="relative z-10 text-center flex flex-col items-center">
                <div className="text-[32px] font-medium text-cyan-400 tracking-tight leading-none mb-1">1000 Tkns</div>
                <div className="text-[13px] text-white/50 mb-1">in just</div>
                <div className="text-[72px] font-bold text-transparent bg-clip-text bg-gradient-to-b from-white to-white/60 tracking-tighter leading-none">
                  $0.01
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Do more, spend less</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-2">
                Forget burning cash on bloated infra. With OpenLinear you get enterprise-grade memory at 70% lower cost.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Hex() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M12 2L20.6603 7V17L12 22L3.33975 17V7L12 2Z" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}
