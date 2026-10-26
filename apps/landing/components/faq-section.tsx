const faqs = [
  {
    question: "How is this different from GitHub Copilot?",
    answer:
      "Copilot helps you write code with autocomplete. OpenLinear executes entire tasks autonomously\u2014it plans, implements, and opens PRs. You describe what you want; it delivers working code.",
  },
  {
    question: "Is my code safe?",
    answer:
      "Yes. OpenLinear runs entirely on your machine. Your code never leaves your computer. All execution happens locally in isolated workspaces.",
  },
  {
    question: "Which AI agents does OpenLinear support?",
    answer:
      "OpenLinear currently works with OpenCode. Want to see something else? Open an issue on GitHub.",
  },
]

export function FAQSection() {
  return (
    <section className="py-20 md:py-24 px-6 md:px-20">
      <div className="mx-auto max-w-content">
        <p className="text-[13px] text-label mb-10 tracking-wide uppercase">
          Frequently asked questions
        </p>

        <dl className="space-y-8">
          {faqs.map((faq) => (
            <div key={faq.question}>
              <dt className="text-[16px] font-semibold leading-[24px] mb-2">
                {faq.question}
              </dt>
              <dd className="text-[15px] leading-[22px] text-muted-foreground">
                {faq.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
