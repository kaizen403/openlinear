'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import MotionWrapper from './motion-wrapper'

const faqs = [
  {
    question: 'What is KazCode?',
    answer: 'KazCode is a desktop kanban board that executes coding tasks through AI agents. Think of it as Linear meets AI — you create tasks, and AI implements them in your repo.',
  },
  {
    question: 'How does task execution work?',
    answer: 'When you hit Execute, the AI agent clones your repo, creates a branch, works on the task, commits changes, and opens a pull request. You see progress in real time.',
  },
  {
    question: 'What AI agents are supported?',
    answer: 'Currently OpenCode is integrated. Claude Code, Codex, and Aider are planned for future releases.',
  },
  {
    question: 'Can I run multiple tasks at once?',
    answer: 'Yes. Batch execution supports both parallel mode (run N tasks simultaneously) and queue mode (one at a time, with optional auto-approve).',
  },
  {
    question: 'How does team collaboration work?',
    answer: 'Create teams with invite codes. Teams scope issue numbering (like ENG-1, ENG-2) and share projects and tasks.',
  },
  {
    question: 'Is KazCode free?',
    answer: 'Yes. KazCode is open source and free to use. You need your own AI provider API keys or an OpenCode installation.',
  },
  {
    question: 'What platforms are supported?',
    answer: 'macOS and Linux. Available as .dmg, AppImage, and .deb. Windows support is planned.',
  },
  {
    question: 'Does KazCode store my code?',
    answer: 'No. Everything runs locally on your machine. Code is cloned into local directories and executed in Docker containers on your hardware.',
  },
]

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    <section className="py-20 md:py-28 border-t border-border" id="faq">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <MotionWrapper>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground text-center mb-12">
            FAQ
          </h2>
        </MotionWrapper>

        <MotionWrapper delay={0.15}>
          <div className="divide-y divide-border">
            {faqs.map((faq, index) => (
              <div key={index}>
                <button
                  onClick={() => setOpenIndex(openIndex === index ? null : index)}
                  className="w-full flex items-center justify-between py-4 text-left hover:bg-white/5 transition-colors"
                  aria-expanded={openIndex === index}
                >
                  <span className="font-medium text-foreground pr-4">{faq.question}</span>
                  <ChevronDown
                    className={`w-5 h-5 text-muted-foreground flex-shrink-0 transition-transform duration-200 ${
                      openIndex === index ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                <div
                  className={`overflow-hidden transition-[max-height] duration-300 ease-in-out ${
                    openIndex === index ? 'max-h-96' : 'max-h-0'
                  }`}
                >
                  <div className="pb-4 text-muted-foreground leading-7">
                    {faq.answer}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </MotionWrapper>
      </div>
    </section>
  )
}
