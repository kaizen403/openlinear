"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  const faqs = [
    {
      question: "What exactly does OpenLinear do?",
      answer: "OpenLinear is an AI-powered task execution platform that connects to your GitHub repositories. You create tasks on a kanban board, and our AI agents implement them by writing code, creating branches, and opening pull requests. You review the code and merge when ready. It's like having a team of developers that work 24/7."
    },
    {
      question: "How is this different from GitHub Copilot?",
      answer: "GitHub Copilot helps you write code faster with autocomplete suggestions. OpenLinear goes further - it understands entire tasks, plans the implementation, creates branches, writes complete features, and opens PRs. Copilot assists you while you code; OpenLinear does the coding for you."
    },
    {
      question: "Is my code safe with OpenLinear?",
      answer: "Absolutely. OpenLinear is self-hosted, meaning all code execution happens on your own infrastructure. We never store or access your source code. The AI works within your environment, and all changes go through your normal GitHub review process. You have full control and visibility."
    },
    {
      question: "What types of tasks work best with OpenLinear?",
      answer: "OpenLinear excels at well-defined, scoped tasks like: adding new features, fixing bugs, writing tests, refactoring code, updating documentation, and API integrations. Tasks that require clear specifications and have measurable outcomes work best. Complex architectural decisions still benefit from human oversight."
    },
    {
      question: "How accurate is the AI-generated code?",
      answer: "Our AI produces production-quality code following best practices. It includes proper error handling, type safety, tests, and documentation. However, we always recommend code review before merging. Most users find the code requires minimal to no changes - typically just style preferences or minor adjustments."
    },
    {
      question: "Can I use OpenLinear with my existing tools?",
      answer: "Yes! OpenLinear integrates seamlessly with GitHub, works alongside your existing CI/CD pipelines, and fits into your current workflow. You can use it with Jira, Linear, Slack, and other tools you already use. The AI-generated PRs work exactly like human-created PRs."
    },
    {
      question: "What programming languages are supported?",
      answer: "OpenLinear supports all major programming languages including TypeScript/JavaScript, Python, Go, Rust, Java, Ruby, PHP, and more. The AI is trained on billions of lines of code across many languages and frameworks, so it can work with virtually any tech stack."
    },
    {
      question: "Is there a free trial?",
      answer: "Yes! Our Free tier includes 100 tasks per month with no credit card required. This lets you fully evaluate OpenLinear with your real projects. Upgrade to Pro or Scale when you need more tasks or advanced features."
    }
  ]

  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-[#0a0f1a]" />
      
      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <span className="inline-block px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 mb-6">
            FAQ
          </span>
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-[-0.02em] text-white leading-[1.1]">
            Questions? Answered.
          </h2>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <FAQItem
              key={index}
              question={faq.question}
              answer={faq.answer}
              isOpen={openIndex === index}
              onClick={() => setOpenIndex(openIndex === index ? null : index)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function FAQItem({
  question,
  answer,
  isOpen,
  onClick,
}: {
  question: string
  answer: string
  isOpen: boolean
  onClick: () => void
}) {
  return (
    <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-between p-6 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="text-lg font-medium text-white pr-8">{question}</span>
        <ChevronDown
          className={`h-5 w-5 text-white/40 flex-shrink-0 transition-transform duration-300 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      
      <div
        className={`overflow-hidden transition-all duration-300 ${
          isOpen ? "max-h-96" : "max-h-0"
        }`}
      >
        <div className="px-6 pb-6">
          <p className="text-white/50 leading-relaxed">{answer}</p>
        </div>
      </div>
    </div>
  )
}
