"use client"

import { useState } from "react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight, Mail, Clock, Github, CheckCircle2, MessageCircle } from "lucide-react"

export default function ContactPage() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [company, setCompany] = useState("")
  const [message, setMessage] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
  }

  return (
    <main>
      <Header />

      {/* ── Hero ─────────────────────────────────── */}
      <section className="relative min-h-[85svh] flex flex-col justify-center overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />
        <div className="absolute top-[-15%] left-[30%] w-[600px] h-[500px] rounded-full bg-[hsl(200_40%_25%/0.12)] blur-[180px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[15%] w-[500px] h-[400px] rounded-full bg-[hsl(45_30%_25%/0.1)] blur-[160px] pointer-events-none" />
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: '80px 80px'
        }} />
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        <div className="relative mx-auto max-w-none px-[100px] w-full text-center pt-40 pb-16">
          <span className="hero-reveal-1 inline-block text-[0.75rem] font-semibold text-[#EDE8D0]/40 tracking-[0.2em] uppercase mb-8">
            Contact
          </span>
          <h1 className="hero-reveal-2 font-display text-[2.75rem] md:text-[3.75rem] lg:text-[4.5rem] font-bold tracking-[-0.05em] text-[#EDE8D0] leading-[1.02] max-w-3xl mx-auto">
            Get in <span className="font-editorial italic">touch</span>.
          </h1>
          <p className="hero-reveal-3 text-[#EDE8D0]/40 leading-[1.75] text-[1.0625rem] tracking-[-0.01em] max-w-lg mx-auto mt-8">
            Have a question, need a demo, or want to discuss enterprise options? We&apos;d love to hear from you.
          </p>
        </div>

        {/* Info cards — inside the hero */}
        <div className="hero-reveal-4 relative mx-auto max-w-none px-[100px] w-full pb-20">
          <div className="grid md:grid-cols-3 gap-5 max-w-3xl mx-auto">
            {[
              {
                icon: Clock,
                title: "Response Time",
                detail: "We respond within 24 hours",
              },
              {
                icon: Mail,
                title: "Email",
                detail: "hello@openlinear.dev",
                href: "mailto:hello@openlinear.dev",
              },
              {
                icon: Github,
                title: "GitHub",
                detail: "kaizen403/openlinear",
                href: "https://github.com/kaizen403/openlinear",
              },
            ].map((item) => (
              <div key={item.title} className="glass-panel rounded-xl p-5 flex items-center gap-4 group">
                <div className="h-10 w-10 rounded-lg bg-[#EDE8D0]/[0.05] border border-[#EDE8D0]/[0.08] flex items-center justify-center shrink-0 group-hover:bg-[#EDE8D0]/[0.08] transition-colors duration-300">
                  <item.icon className="h-4 w-4 text-[#EDE8D0]/60" />
                </div>
                <div>
                  <p className="text-[0.8125rem] font-medium text-[#EDE8D0]/80 tracking-[-0.01em]">
                    {item.title}
                  </p>
                  {item.href ? (
                    <a
                      href={item.href}
                      className="text-[0.75rem] text-[#EDE8D0]/50 hover:text-[#EDE8D0]/70 transition-colors duration-250"
                    >
                      {item.detail}
                    </a>
                  ) : (
                    <p className="text-[0.75rem] text-[#EDE8D0]/35">
                      {item.detail}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Form + Sidebar ───────────────────────── */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />

        {/* Atmospheric depth glow */}
        <div className="absolute top-[20%] right-[-5%] w-[400px] h-[400px] rounded-full bg-[hsl(200_40%_25%/0.08)] blur-[160px] pointer-events-none" />

        {/* Floating glass-panel: "Message sent" confirmation card */}
        <div className="hidden lg:block absolute bottom-16 right-12 z-10 animate-float-3">
          <div className="glass-panel rounded-2xl p-5 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-[#EDE8D0]/[0.08] border border-[#EDE8D0]/[0.06] flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-4 w-4 text-[#EDE8D0]/60" />
            </div>
            <div>
              <p className="text-[0.8125rem] font-medium text-[#EDE8D0]/90 tracking-[-0.01em]">Message sent</p>
              <p className="text-[0.6875rem] text-[#EDE8D0]/40">We&apos;ll be in touch shortly</p>
            </div>
          </div>
        </div>

        {/* Floating glass-panel: Response time pill */}
        <div className="hidden lg:block absolute top-24 right-20 z-10 animate-float-5">
          <div className="glass-panel rounded-xl p-4 flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-[#EDE8D0]/[0.08] border border-[#EDE8D0]/[0.06] flex items-center justify-center shrink-0">
              <MessageCircle className="h-3.5 w-3.5 text-[#EDE8D0]/60" />
            </div>
            <p className="text-[0.75rem] font-medium text-[#EDE8D0]/70 tracking-[-0.01em]">Avg. reply: &lt; 24h</p>
          </div>
        </div>

        <div className="mx-auto max-w-none px-[100px]">
          <div className="grid lg:grid-cols-[1.3fr_1fr] gap-14 lg:gap-24 max-w-5xl mx-auto">
            <form onSubmit={handleSubmit} autoComplete="off" className="flex flex-col gap-5">
              <div>
                <label htmlFor="name" className="text-[0.8125rem] font-medium text-foreground/80 mb-2 block">
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  required
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full rounded-lg border border-border/50 bg-background px-4 py-3 text-[0.875rem] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40 transition-all duration-200"
                />
              </div>
              <div>
                <label htmlFor="email" className="text-[0.8125rem] font-medium text-foreground/80 mb-2 block">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-border/50 bg-background px-4 py-3 text-[0.875rem] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40 transition-all duration-200"
                />
              </div>
              <div>
                <label htmlFor="company" className="text-[0.8125rem] font-medium text-foreground/80 mb-2 block">
                  Company
                </label>
                <input
                  id="company"
                  type="text"
                  autoComplete="off"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-border/50 bg-background px-4 py-3 text-[0.875rem] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40 transition-all duration-200"
                />
              </div>
              <div>
                <label htmlFor="message" className="text-[0.8125rem] font-medium text-foreground/80 mb-2 block">
                  Message
                </label>
                <textarea
                  id="message"
                  required
                  autoComplete="off"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Tell us what you need"
                  className="w-full rounded-lg border border-border/50 bg-background px-4 py-3 text-[0.875rem] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40 transition-all duration-200 min-h-[120px] resize-none"
                />
              </div>
              <button
                type="submit"
                className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-7 py-3 text-[0.875rem] font-medium text-primary-foreground w-fit mt-2"
              >
                Send message <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </form>

            {/* What to expect */}
            <div className="flex flex-col gap-10">
              <div>
                <h3 className="font-display text-[1.125rem] font-bold tracking-[-0.03em] text-foreground mb-6">
                  What to expect
                </h3>
                <div className="flex flex-col gap-6">
                  {[
                    { step: "01", title: "Submit your message", description: "Fill out the form and we'll receive your inquiry immediately." },
                    { step: "02", title: "We review your needs", description: "Our team evaluates your use case and prepares a tailored response." },
                    { step: "03", title: "We respond within 24h", description: "Expect a detailed reply or a call invite within one business day." },
                  ].map((item) => (
                    <div key={item.step} className="flex items-start gap-4">
                      <span className="text-[0.75rem] font-semibold text-primary/50 font-mono mt-0.5 shrink-0 w-6">
                        {item.step}
                      </span>
                      <div>
                        <p className="text-[0.875rem] font-medium text-foreground/80 tracking-[-0.01em]">
                          {item.title}
                        </p>
                        <p className="text-[0.75rem] text-muted-foreground/45 leading-[1.6] mt-1">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-[1px] bg-border/20" />

              <div>
                <h3 className="font-display text-[1.125rem] font-bold tracking-[-0.03em] text-foreground mb-4">
                  Direct channels
                </h3>
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[0.75rem] text-muted-foreground/40 mb-1">Email</p>
                    <a
                      href="mailto:hello@openlinear.dev"
                      className="text-primary/80 hover:text-primary text-[0.875rem] transition-colors duration-250"
                    >
                      hello@openlinear.dev
                    </a>
                  </div>
                  <div>
                    <p className="text-[0.75rem] text-muted-foreground/40 mb-1">GitHub</p>
                    <a
                      href="https://github.com/kaizen403/openlinear"
                      className="text-primary/80 hover:text-primary text-[0.875rem] transition-colors duration-250"
                    >
                      github.com/kaizen403/openlinear
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
