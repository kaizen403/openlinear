"use client"

import { useState, useEffect, useRef, useCallback, ReactNode, Suspense } from "react"
import { PanelLeft } from "lucide-react"
import { Sidebar } from "./sidebar"

const MIN_WIDTH = 200
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 256

interface AppShellProps {
    children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
    const [sidebarOpen, setSidebarOpen] = useState(true)
    const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH)
    const [dragging, setDragging] = useState(false)
    const [isMobile, setIsMobile] = useState(false)
    const startX = useRef(0)
    const startWidth = useRef(DEFAULT_WIDTH)

    /* Track mobile breakpoint */
    useEffect(() => {
        const mq = window.matchMedia("(max-width: 768px)")
        const handler = (e: MediaQueryListEvent | MediaQueryList) => {
            setIsMobile(e.matches)
            if (e.matches) {
                setSidebarOpen(false)
            }
        }
        handler(mq)
        mq.addEventListener("change", handler)
        return () => mq.removeEventListener("change", handler)
    }, [])

    /* Drag handlers — disabled on mobile */
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (isMobile) return
        e.preventDefault()
        setDragging(true)
        startX.current = e.clientX
        startWidth.current = sidebarWidth
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
    }, [sidebarWidth, isMobile])

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!dragging) return
            const delta = e.clientX - startX.current
            const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
            setSidebarWidth(newWidth)
        }

        const handleMouseUp = () => {
            if (!dragging) return
            setDragging(false)
            document.body.style.cursor = ""
            document.body.style.userSelect = ""
        }

        window.addEventListener("mousemove", handleMouseMove)
        window.addEventListener("mouseup", handleMouseUp)
        return () => {
            window.removeEventListener("mousemove", handleMouseMove)
            window.removeEventListener("mouseup", handleMouseUp)
        }
    }, [dragging])

    const closeSidebar = useCallback(() => setSidebarOpen(false), [])

    return (
        <div className="flex h-screen bg-linear-bg text-linear-text overflow-hidden">
            {/* Mobile overlay backdrop */}
            {isMobile && sidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                    onClick={closeSidebar}
                />
            )}

            {/* Sidebar — overlay on mobile, inline on desktop */}
            <div
                className={
                    isMobile
                        ? "fixed inset-y-0 left-0 z-50"
                        : "relative z-10 flex-shrink-0"
                }
            >
                <Suspense>
                    <Sidebar
                        open={sidebarOpen}
                        onClose={closeSidebar}
                        width={isMobile ? 280 : sidebarWidth}
                        animating={!dragging}
                    />
                </Suspense>
            </div>

            {/* Drag handle — only visible when sidebar is open on desktop */}
            {!isMobile && sidebarOpen && (
                <div
                    onMouseDown={handleMouseDown}
                    className="w-1 flex-shrink-0 cursor-col-resize relative group z-10 -ml-px"
                >
                    <div className="absolute inset-y-0 left-0 w-0.5 bg-transparent group-hover:bg-linear-accent/40 transition-colors duration-150" />
                </div>
            )}

            <div
                className="flex-1 flex flex-col min-w-0"
                style={{
                    paddingLeft: sidebarOpen ? 0 : 48,
                    transition: dragging ? 'none' : 'padding-left 150ms cubic-bezier(0.25, 0.1, 0.25, 1)',
                }}
            >
                {children}
            </div>

            {/* Floating sidebar toggle — fades in/out */}
            <button
                onClick={() => setSidebarOpen(true)}
                className="fixed top-3 left-3 z-50 w-8 h-8 rounded-md flex items-center justify-center bg-linear-bg-secondary border border-linear-border text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary shadow-lg"
                style={{
                    opacity: sidebarOpen ? 0 : 1,
                    transform: sidebarOpen ? 'scale(0.8)' : 'scale(1)',
                    pointerEvents: sidebarOpen ? 'none' : 'auto',
                    transition: 'opacity 150ms ease, transform 150ms ease',
                }}
                aria-label="Open sidebar"
            >
                <PanelLeft className="w-4 h-4" />
            </button>
        </div>
    )
}
