"use client"

import { useEffect, useRef, useState } from "react"

interface LineData {
    text: string
    gradient?: { word: string; from: string; to: string }
}

const lines: LineData[] = [
    { text: "Task boards don't ship code." },
    { text: "Most tools stop at planning." },
    {
        text: "OpenLinear goes further.",
        gradient: { word: "OpenLinear", from: "#a78bfa", to: "#7c3aed" },
    },
    {
        text: "Write a task. Click Execute.",
        gradient: { word: "Execute", from: "#fbbf24", to: "#f59e0b" },
    },
    { text: "An AI agent clones your repo." },
    { text: "Creates a branch. Writes the code." },
    {
        text: "Opens a real pull request.",
        gradient: { word: "pull request", from: "#34d399", to: "#10b981" },
    },
    { text: "You review. You merge. Done." },
]

function renderLine(line: LineData, opacity: number) {
    if (!line.gradient) {
        return <span style={{ opacity }}>{line.text}</span>
    }

    const { word, from, to } = line.gradient
    const idx = line.text.indexOf(word)
    if (idx === -1) return <span style={{ opacity }}>{line.text}</span>

    const before = line.text.slice(0, idx)
    const after = line.text.slice(idx + word.length)

    return (
        <>
            <span style={{ opacity }}>{before}</span>
            <span
                className="bg-clip-text text-transparent"
                style={{
                    backgroundImage: `linear-gradient(90deg, ${from}, ${to})`,
                    opacity: Math.min(1, opacity * 1.2),
                }}
            >
                {word}
            </span>
            <span style={{ opacity }}>{after}</span>
        </>
    )
}

export function TextHighlighter() {
    const sectionRef = useRef<HTMLDivElement>(null)
    const [progress, setProgress] = useState(0)

    useEffect(() => {
        const section = sectionRef.current
        if (!section) return

        const handleScroll = () => {
            const rect = section.getBoundingClientRect()
            const windowHeight = window.innerHeight
            const scrollStart = windowHeight * 0.4
            const scrollEnd = -rect.height + windowHeight * 0.3
            const rawProgress = (scrollStart - rect.top) / (scrollStart - scrollEnd)
            setProgress(Math.max(0, Math.min(1, rawProgress)))
        }

        window.addEventListener("scroll", handleScroll, { passive: true })
        handleScroll()
        return () => window.removeEventListener("scroll", handleScroll)
    }, [])

    return (
        <section
            ref={sectionRef}
            className="relative py-32 md:py-48 overflow-hidden"
        >
            <div className="absolute inset-0 bg-[#161820]" />
            <div className="absolute top-0 left-[30%] w-[600px] h-[400px] rounded-full bg-[hsl(45_30%_25%/0.08)] blur-[180px] pointer-events-none" />
            <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(0_0%_100%/0.04)] to-transparent" />

            <div className="relative mx-auto max-w-none px-[100px]">
                <div className="max-w-3xl mx-auto flex flex-col gap-3">
                    {lines.map((line, i) => {
                        const total = lines.length
                        // Each line has a "window" where it's active
                        const center = (i + 0.5) / total
                        const halfWidth = 1.5 / total // how wide the active window is

                        const dist = Math.abs(progress - center)
                        // Active: full brightness at center, fades as you scroll away
                        let opacity: number
                        if (dist < halfWidth * 0.4) {
                            opacity = 1
                        } else if (dist < halfWidth) {
                            opacity = 1 - ((dist - halfWidth * 0.4) / (halfWidth * 0.6)) * 0.75
                        } else {
                            // Faded — either not reached yet or scrolled past
                            opacity = Math.max(0.06, 0.25 - (dist - halfWidth) * 0.5)
                        }

                        return (
                            <p
                                key={i}
                                className="font-display text-[1.75rem] md:text-[2.25rem] lg:text-[2.75rem] font-bold tracking-[-0.04em] leading-[1.15] transition-all duration-500 ease-out text-[#EDE8D0]"
                                style={{
                                    transform: `translateY(${opacity > 0.5 ? 0 : 4}px)`,
                                }}
                            >
                                {renderLine(line, opacity)}
                            </p>
                        )
                    })}
                </div>
            </div>
        </section>
    )
}
