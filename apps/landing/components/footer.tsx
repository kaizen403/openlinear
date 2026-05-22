type FooterLink = { label: string; href: string; external?: boolean }

const footerLinks: Record<string, FooterLink[]> = {
  Product: [
    { label: "Overview", href: "/product" },
    { label: "Pricing", href: "/pricing" },
    { label: "Enterprise", href: "/enterprise" },
    { label: "Docs", href: "/docs" },
  ],
  Company: [
    { label: "Contact Us", href: "/contact" },
  ],
}

const socialLinks: FooterLink[] = [
  // GitHub URL is a placeholder pending T41 (real org URL)
  { label: "GitHub", href: "https://github.com/openlinear/openlinear", external: true },
]

const socialIcons: Record<string, string> = {
  GitHub: "gh",
}

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
              <span className="font-display text-[0.8125rem] font-semibold tracking-[0.08em] text-[#9c9580] uppercase">
                OpenLinear
              </span>
            </div>
            <p className="text-[0.875rem] text-[#9c9580]/40 leading-[1.6]">
              Execute your tasks.
              <br />
              Don&apos;t just track them.
            </p>
          </div>

          {/* Link columns — right side */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-10 lg:gap-16 flex-1">
            {Object.entries(footerLinks).map(([category, links]) => (
              <div key={category} className="flex flex-col gap-5">
                <p className="text-[0.8125rem] font-semibold text-[#9c9580]/90 tracking-[-0.01em]">{category}</p>
                <ul className="flex flex-col gap-3">
                  {links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-[0.8125rem] text-[#9c9580]/35 hover:text-[#9c9580]/70 transition-colors duration-300"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {/* Connect column */}
            <div className="flex flex-col gap-5">
              <p className="text-[0.8125rem] font-semibold text-[#9c9580]/90 tracking-[-0.01em]">Connect</p>
              <ul className="flex flex-col gap-3">
                {socialLinks.map((social) => (
                  <li key={social.label}>
                    <a
                      href={social.href}
                      target={social.external ? "_blank" : undefined}
                      rel={social.external ? "noopener noreferrer" : undefined}
                      className="flex items-center gap-2.5 text-[0.8125rem] text-[#9c9580]/35 hover:text-[#9c9580]/70 transition-colors duration-300"
                    >
                      <span className="text-[0.6875rem] font-mono w-5 text-center opacity-60">{socialIcons[social.label] ?? ""}</span>
                      {social.label}
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
        <p className="font-display text-[5rem] md:text-[8rem] lg:text-[12rem] font-bold tracking-[-0.05em] text-[#9c9580]/[0.03] leading-none select-none whitespace-nowrap">
          OPENLINEAR
        </p>
      </div>
    </footer>
  )
}
