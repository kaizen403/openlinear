"use client"

import { useState } from "react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight } from "lucide-react"

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

      <section className="relative bg-background pt-40 pb-20">
        <div className="mx-auto max-w-none px-[100px]">
          <span className="text-[0.75rem] font-semibold text-primary/60 mb-5 tracking-[-0.01em] block">
            Contact
          </span>
          <h1 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-foreground text-balance leading-[1.04] mt-5">
            Get in touch.
          </h1>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-6">
            Have a question or want to learn more? Reach out.
          </p>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="grid lg:grid-cols-2 gap-14 lg:gap-24">
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div>
                <label htmlFor="name" className="text-[0.8125rem] font-medium text-foreground/80 mb-2 block">
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  required
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

            <div>
              <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                Email
              </h3>
              <a
                href="mailto:hello@openlinear.dev"
                className="text-primary/80 hover:text-primary text-[0.9375rem] transition-colors duration-250"
              >
                hello@openlinear.dev
              </a>
              <div className="mt-8">
                <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                  GitHub
                </h3>
                <a
                  href="https://github.com/kaizen403/openlinear"
                  className="text-primary/80 hover:text-primary text-[0.9375rem] transition-colors duration-250"
                >
                  github.com/kaizen403/openlinear
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
