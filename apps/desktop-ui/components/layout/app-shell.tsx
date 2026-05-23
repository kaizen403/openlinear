"use client"

import { useState, useEffect, useRef, useCallback, ReactNode, Suspense } from "react"
import { Sidebar } from "./sidebar"

const MIN_WIDTH = 200
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 256
const STORAGE_KEY_OPEN = "openlinear-sidebar-open"
const STORAGE_KEY_WIDTH = "openlinear-sidebar-width"

function readStoredBoolean(key: string, fallback: boolean): boolean {
    if (typeof window === "undefined") return fallback
    const stored = localStorage.getItem(key)
    if (stored === null) return fallback
    return stored === "true"
}

function readStoredNumber(key: string, fallback: number): number {
    if (typeof window === "undefined") return fallback
    const stored = localStorage.getItem(key)
    if (stored === null) return fallback
    const n = Number(stored)
    return Number.isFinite(n) ? n : fallback
}

interface AppShellProps {
    children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
    const [sidebarOpen, setSidebarOpen] = useState(true)
    const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH)
    const [dragging, setDragging] = useState(false)
    const [isMobile, setIsMobile] = useState(false)
    const [mounted, setMounted] = useState(false)
    const startX = useRef(0)
    const startWidth = useRef(DEFAULT_WIDTH)
    const pendingWidth = useRef<number | null>(null)
    const resizeFrame = useRef<number | null>(null)

    /* Hydration-safe: read localStorage only after mount */
    useEffect(() => {
        setSidebarOpen(true)
        setSidebarWidth(readStoredNumber(STORAGE_KEY_WIDTH, DEFAULT_WIDTH))
        setMounted(true)
    }, [])

    /* Track mobile breakpoint */
    useEffect(() => {
        const mq = window.matchMedia("(max-width: 1024px)")
        setIsMobile(mq.matches)
        const handler = (e: MediaQueryListEvent) => {
            setIsMobile(e.matches)
            if (e.matches) {
                setSidebarOpen(false)
            } else {
                setSidebarOpen(true)
            }
        }
        mq.addEventListener("change", handler)
        return () => mq.removeEventListener("change", handler)
    }, [])

    /* Persist sidebar state to localStorage (width only, open state always defaults to true) */

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY_WIDTH, String(sidebarWidth))
    }, [sidebarWidth])

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
            pendingWidth.current = newWidth
            if (resizeFrame.current !== null) return
            resizeFrame.current = window.requestAnimationFrame(() => {
                resizeFrame.current = null
                if (pendingWidth.current !== null) {
                    setSidebarWidth(pendingWidth.current)
                }
            })
        }

        const handleMouseUp = () => {
            if (!dragging) return
            setDragging(false)
            document.body.style.cursor = ""
            document.body.style.userSelect = ""
            if (resizeFrame.current !== null) {
                window.cancelAnimationFrame(resizeFrame.current)
                resizeFrame.current = null
            }
            if (pendingWidth.current !== null) {
                setSidebarWidth(pendingWidth.current)
                pendingWidth.current = null
            }
        }

        window.addEventListener("mousemove", handleMouseMove)
        window.addEventListener("mouseup", handleMouseUp)
        return () => {
            window.removeEventListener("mousemove", handleMouseMove)
            window.removeEventListener("mouseup", handleMouseUp)
            if (resizeFrame.current !== null) {
                window.cancelAnimationFrame(resizeFrame.current)
                resizeFrame.current = null
            }
        }
    }, [dragging])

    const closeSidebar = useCallback(() => setSidebarOpen(false), [])

    const effectiveWidth = isMobile ? 300 : sidebarWidth

    return (
        <div className="flex h-screen min-h-0 bg-linear-bg text-linear-text overflow-hidden">
            {/* Mobile overlay backdrop */}
            {isMobile && sidebarOpen && (
                <button
                    type="button"
                    className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                    onClick={closeSidebar}
                    aria-label="Close sidebar"
                />
            )}

            {/* Sidebar wrapper — width transition drives the layout shift */}
            <div
                className={
                    isMobile
                        ? "fixed inset-y-0 left-0 z-50"
                        : "relative z-10 flex-shrink-0 overflow-hidden"
                }
                style={isMobile ? undefined : {
                    width: sidebarOpen ? `${effectiveWidth}px` : '0px',
                    transition: !mounted ? 'none' : 'width 300ms cubic-bezier(0.4, 0, 0.2, 1)',
                }}
            >
                <Suspense>
                    <Sidebar
                        open={sidebarOpen}
                        onClose={closeSidebar}
                        width={effectiveWidth}
                    />
                </Suspense>
            </div>

            {/* Drag handle — only visible when sidebar is open on desktop */}
            {!isMobile && sidebarOpen && (
                <button
                    type="button"
                    onMouseDown={handleMouseDown}
                    className="w-2 flex-shrink-0 cursor-col-resize relative group z-10 -ml-1"
                    aria-label="Resize sidebar"
                >
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] bg-transparent group-hover:bg-linear-accent/60 transition-colors duration-150" />
                </button>
            )}

            <div
                className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden"
            >
                {children}
            </div>

            {/* Floating sidebar toggle */}
            <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="fixed top-3 left-3 z-50 w-8 h-8 rounded-sm flex items-center justify-center bg-linear-bg-secondary/95 border border-linear-border hover:bg-linear-bg-tertiary shadow-lg backdrop-blur"
                style={{
                    opacity: sidebarOpen ? 0 : 1,
                    pointerEvents: sidebarOpen ? 'none' : 'auto',
                    transition: 'opacity 200ms ease',
                }}
                aria-label="Open sidebar"
            >
                <img src="/brand/logo.png" alt="OpenLinear" className="h-4 w-4 object-contain" />
            </button>
        </div>
    )
}
