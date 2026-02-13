'use client'

import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { Draggable } from 'gsap/Draggable'

gsap.registerPlugin(Draggable)

export default function JellyLogo() {
  const containerRef = useRef<HTMLDivElement>(null)
  const logoRef = useRef<HTMLImageElement>(null)
  const velocityRef = useRef(0)
  const rafRef = useRef<number>()

  useEffect(() => {
    const container = containerRef.current
    const logo = logoRef.current
    if (!container || !logo) return

    const springStrength = 0.15
    const damping = 0.75
    const maxStretch = 0.4
    const squashAmount = 0.3

    let isDragging = false
    let lastY = 0

    let draggableInstance: ReturnType<typeof Draggable.create>[number] | null = null

    const draggables = Draggable.create(container, {
      type: 'y',
      bounds: { minY: -100, maxY: 100 },
      inertia: true,
      onDragStart: function() {
        isDragging = true
        lastY = this.y
      },
      onDrag: function() {
        const currentY = this.y
        const deltaY = currentY - lastY
        velocityRef.current = deltaY
        lastY = currentY

        const stretch = Math.abs(currentY) / 100
        const targetScaleY = 1 - Math.min(stretch * squashAmount, maxStretch)
        const targetScaleX = 1 + Math.min(stretch * squashAmount * 0.5, maxStretch * 0.5)

        gsap.set(logo, {
          scaleY: targetScaleY,
          scaleX: targetScaleX,
        })
      },
      onDragEnd: function() {
        isDragging = false
        gsap.to(logo, {
          scaleY: 1,
          scaleX: 1,
          duration: 0.6,
          ease: 'elastic.out(1, 0.4)',
        })
      },
    })
    draggableInstance = draggables[0]

    const handleMouseEnter = () => {
      gsap.to(logo, {
        scaleY: 0.95,
        scaleX: 1.02,
        duration: 0.2,
        ease: 'power2.out',
      })
    }

    const handleMouseLeave = () => {
      if (!isDragging) {
        gsap.to(logo, {
          scaleY: 1,
          scaleX: 1,
          duration: 0.4,
          ease: 'elastic.out(1, 0.5)',
        })
      }
    }

    container.addEventListener('mouseenter', handleMouseEnter)
    container.addEventListener('mouseleave', handleMouseLeave)

    let lastScrollY = window.scrollY
    const handleScroll = () => {
      const scrollY = window.scrollY
      const scrollDelta = scrollY - lastScrollY
      lastScrollY = scrollY

      const scrollVelocity = Math.min(Math.abs(scrollDelta) / 50, 1)
      if (scrollVelocity > 0.1 && !isDragging) {
        gsap.to(logo, {
          scaleY: 1 - scrollVelocity * 0.1,
          scaleX: 1 + scrollVelocity * 0.05,
          duration: 0.1,
          ease: 'power2.out',
          onComplete: () => {
            gsap.to(logo, {
              scaleY: 1,
              scaleX: 1,
              duration: 0.6,
              ease: 'elastic.out(1, 0.4)',
            })
          },
        })
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })

    const handleClick = () => {
      if (!isDragging) {
        gsap.to(logo, {
          scaleY: 0.7,
          scaleX: 1.15,
          duration: 0.1,
          ease: 'power2.out',
          onComplete: () => {
            gsap.to(logo, {
              scaleY: 1,
              scaleX: 1,
              duration: 0.8,
              ease: 'elastic.out(1, 0.3)',
            })
          },
        })
      }
    }

    container.addEventListener('click', handleClick)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      draggables.forEach(d => d.kill())
      container.removeEventListener('mouseenter', handleMouseEnter)
      container.removeEventListener('mouseleave', handleMouseLeave)
      container.removeEventListener('click', handleClick)
      window.removeEventListener('scroll', handleScroll)
    }
  }, [])

  return (
    <div className="relative flex items-center justify-center w-full h-full">
      <div className="absolute inset-0 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-blue-500/20 blur-3xl opacity-50 animate-pulse" />

      <div
        ref={containerRef}
        className="relative cursor-grab active:cursor-grabbing transition-transform will-change-transform"
        style={{ touchAction: 'none' }}
      >
        <img
          ref={logoRef}
          src="/logo.png"
          alt="KazCode"
          className="relative z-10 w-full max-w-[500px] h-auto select-none will-change-transform"
          draggable={false}
        />

        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-3/4 h-4 bg-black/30 blur-xl rounded-full" />
      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-muted-foreground/50 pointer-events-none">
        Drag to squeeze
      </div>
    </div>
  )
}
