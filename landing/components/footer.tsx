const footerLinks = {
  Product: [
    "Overview",
    "Batch Execution",
    "GitHub Integration",
    "Desktop App",
  ],
  Company: [
    "Contact",
    "GitHub",
  ],
  Legal: [
    "Terms",
    "Privacy Policy",
  ],
}

export function Footer() {
  return (
    <footer className="relative overflow-hidden">
      <div className="absolute inset-0 bg-[hsl(230_22%_7%)]" />

      <div className="relative mx-auto max-w-[76rem] px-6 lg:px-10 pt-20 pb-14">
        {/* Top */}
        <div className="flex flex-col lg:flex-row gap-14 lg:gap-28 pb-16 border-b border-[hsl(0_0%_100%/0.04)]">
          {/* Brand */}
          <div className="flex flex-col gap-4 lg:max-w-xs">
            <div className="flex items-center gap-2.5">
              <div className="h-[22px] w-[22px] rounded-[5px] bg-[hsl(0_0%_100%/0.08)] flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="text-[hsl(0_0%_100%/0.55)]">
                  <path d="M3 8L7 12L13 4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="font-display text-[0.75rem] font-semibold tracking-[0.08em] text-[hsl(0_0%_70%)] uppercase">
                OpenLinear
              </span>
            </div>
            <p className="text-[0.8125rem] text-[hsl(228_10%_35%)] leading-[1.65]">
              Execute your tasks. Don&apos;t just track them.
            </p>
          </div>

          {/* Link columns */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-10 lg:gap-20 flex-1">
            {Object.entries(footerLinks).map(([category, links]) => (
              <div key={category} className="flex flex-col gap-5">
                <p className="text-[0.6875rem] font-medium text-[hsl(0_0%_55%)] tracking-[0.04em]">{category}</p>
                <ul className="flex flex-col gap-3.5">
                  {links.map((link) => (
                    <li key={link}>
                      <a
                        href="#"
                        className="text-[0.8125rem] text-[hsl(228_10%_35%)] hover:text-[hsl(0_0%_60%)] transition-colors duration-[300ms]"
                      >
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom */}
        <div className="pt-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-[0.6875rem] text-[hsl(228_10%_25%)]">
            {"Built for developers who ship."}
          </p>
          <p className="text-[0.6875rem] text-[hsl(228_10%_25%)]">
            {"2026 OpenLinear. All rights reserved."}
          </p>
        </div>

        {/* Large watermark */}
        <div className="mt-10 overflow-hidden">
          <p className="font-display text-[6rem] md:text-[10rem] lg:text-[14rem] font-bold tracking-[-0.06em] text-[hsl(0_0%_100%/0.01)] leading-none select-none whitespace-nowrap">
            OPENLINEAR
          </p>
        </div>
      </div>
    </footer>
  )
}
