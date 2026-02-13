'use client'

import { useState } from 'react'
import MotionWrapper from './motion-wrapper'

export default function Newsletter() {
  const [email, setEmail] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    alert('Thanks for subscribing!')
    setEmail('')
  }

  return (
    <section className="py-20 md:py-28 border-t border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <MotionWrapper className="text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground">
            Be the first to know when we release new features
          </h2>
          
          <p className="mt-4 text-muted-foreground">
            Join the waitlist for early access.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 max-w-md mx-auto">
            <div className="flex gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
                className="flex-1 px-4 py-2.5 rounded-lg bg-transparent border border-border focus:border-border-hover focus:outline-none focus:ring-1 focus:ring-border-hover text-foreground placeholder:text-muted"
              />
              <button
                type="submit"
                className="px-6 py-2.5 rounded-lg bg-foreground text-background font-medium hover:bg-foreground/90 transition-colors"
              >
                Subscribe
              </button>
            </div>
          </form>
        </MotionWrapper>
      </div>
    </section>
  )
}
