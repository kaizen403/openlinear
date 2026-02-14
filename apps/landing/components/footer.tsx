const footerLinks = {
  Products: [
    "Overview",
    "Batch Execution",
    "GitHub Integration",
    "Desktop App",
    "Agent Store",
  ],
  Company: [
    "Contact Us",
    "Help Center",
    "Careers",
    "Partners",
  ],
  Legal: [
    "Terms",
    "Privacy Policy",
    "Trust",
    "Legal Notices",
  ],
}

const socialLinks = [
  { name: "LinkedIn", icon: "in" },
  { name: "X", icon: "𝕏" },
  { name: "GitHub", icon: "gh" },
  { name: "Discord", icon: "dc" },
]

export function Footer() {
  return (
    <footer className="relative overflow-hidden">
      <div className="absolute inset-0 bg-[#161820]" />

      <div className="relative mx-auto max-w-none px-[100px] pt-16 pb-8">
        {/* Main footer content */}
        <div className="flex flex-col lg:flex-row gap-12 lg:gap-0">
          {/* Brand — left column */}
          <div className="flex flex-col gap-5 lg:w-[280px] shrink-0">
            <div className="flex items-center">
              <span className="font-display text-[0.8125rem] font-semibold tracking-[0.08em] text-[#EDE8D0] uppercase">
                OpenLinear
              </span>
            </div>
            <p className="text-[0.875rem] text-[#EDE8D0]/40 leading-[1.6]">
              Execute your tasks.
              <br />
              Don&apos;t just track them.
            </p>
          </div>

          {/* Link columns — right side */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10 lg:gap-16 flex-1">
            {Object.entries(footerLinks).map(([category, links]) => (
              <div key={category} className="flex flex-col gap-5">
                <p className="text-[0.8125rem] font-semibold text-[#EDE8D0]/90 tracking-[-0.01em]">{category}</p>
                <ul className="flex flex-col gap-3">
                  {links.map((link) => (
                    <li key={link}>
                      <a
                        href="#"
                        className="text-[0.8125rem] text-[#EDE8D0]/35 hover:text-[#EDE8D0]/70 transition-colors duration-[300ms]"
                      >
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {/* Connect column */}
            <div className="flex flex-col gap-5">
              <p className="text-[0.8125rem] font-semibold text-[#EDE8D0]/90 tracking-[-0.01em]">Connect</p>
              <ul className="flex flex-col gap-3">
                {socialLinks.map((social) => (
                  <li key={social.name}>
                    <a
                      href="#"
                      className="flex items-center gap-2.5 text-[0.8125rem] text-[#EDE8D0]/35 hover:text-[#EDE8D0]/70 transition-colors duration-[300ms]"
                    >
                      <span className="text-[0.6875rem] font-mono w-5 text-center opacity-60">{social.icon}</span>
                      {social.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Large watermark text */}
      <div className="relative w-full flex justify-center mt-4 pb-10 overflow-hidden">
        <p className="font-display text-[5rem] md:text-[8rem] lg:text-[12rem] font-bold tracking-[-0.05em] text-[#EDE8D0]/[0.03] leading-none select-none whitespace-nowrap">
          OPENLINEAR
        </p>
      </div>
    </footer>
  )
}
