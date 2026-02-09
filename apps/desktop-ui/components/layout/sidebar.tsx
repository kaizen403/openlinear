"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
    Layout, Home, Inbox, Layers, Settings, ChevronDown, Circle, Hash,
    Briefcase, PanelLeftClose, Github, LogOut
} from "lucide-react"
import { ProjectSelector } from "@/components/auth/project-selector"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { getLoginUrl } from "@/lib/api"

const navItemClass = (isActive: boolean) =>
    cn(
        "flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer group",
        isActive
            ? "bg-linear-bg-tertiary text-linear-text shadow-sm"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
    )

const sectionHeaderClass =
    "flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider hover:text-linear-text-secondary transition-colors duration-200"

interface SidebarProps {
    open: boolean
    onClose: () => void
    width: number
    animating: boolean
}

export function Sidebar({ open, onClose, width, animating }: SidebarProps) {
    const pathname = usePathname()
    const { user, isAuthenticated, isLoading, activeProject, logout } = useAuth()
    const [teamsExpanded, setTeamsExpanded] = useState(true)
    const [favoritesExpanded, setFavoritesExpanded] = useState(true)
    const [isTauri, setIsTauri] = useState(false)

    useEffect(() => {
        setIsTauri(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
    }, [])

    const handleClose = async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        getCurrentWindow().close()
    }

    const handleMinimize = async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        getCurrentWindow().minimize()
    }

    const handleMaximize = async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        getCurrentWindow().toggleMaximize()
    }

    return (
        <aside
            className="bg-linear-bg-secondary border-r border-linear-border flex flex-col flex-shrink-0 overflow-hidden"
            style={{
                width: open ? width : 0,
                transition: animating ? 'width 150ms cubic-bezier(0.25, 0.1, 0.25, 1)' : 'none',
            }}
        >
            <div className="p-4 border-b border-linear-border flex items-center justify-between min-w-0" data-tauri-drag-region>
                <div className="flex items-center gap-3">
                    {isTauri && (
                        <div className="flex items-center gap-[7px]">
                            <button
                                onClick={handleClose}
                                className="w-[12px] h-[12px] rounded-full bg-[#ff5f57] hover:brightness-110 transition-all flex-shrink-0"
                                aria-label="Close"
                            />
                            <button
                                onClick={handleMinimize}
                                className="w-[12px] h-[12px] rounded-full bg-[#febc2e] hover:brightness-110 transition-all flex-shrink-0"
                                aria-label="Minimize"
                            />
                            <button
                                onClick={handleMaximize}
                                className="w-[12px] h-[12px] rounded-full bg-[#28c840] hover:brightness-110 transition-all flex-shrink-0"
                                aria-label="Maximize"
                            />
                        </div>
                    )}
                    <span className="text-base font-semibold text-linear-text">OpenLinear</span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={onClose}
                        className="w-6 h-6 rounded flex items-center justify-center text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors"
                        aria-label="Collapse sidebar"
                    >
                        <PanelLeftClose className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {isAuthenticated && (
                <div className="p-3 border-b border-linear-border min-w-0">
                    <ProjectSelector />
                </div>
            )}

            <nav className="flex-1 overflow-y-auto py-2 min-w-0">
                <div className="px-3 space-y-0.5">
                    <Link href="/" className={navItemClass(pathname === "/")}>
                        <Home className="w-4 h-4" />
                        Home
                    </Link>
                    <Link href="/inbox" className={navItemClass(pathname === "/inbox")}>
                        <Inbox className="w-4 h-4" />
                        Inbox
                        <span className="ml-auto text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-1.5 py-0.5 rounded">
                            3
                        </span>
                    </Link>
                    <Link href="/my-issues" className={navItemClass(pathname === "/my-issues")}>
                        <Layers className="w-4 h-4" />
                        My Issues
                    </Link>
                </div>

                {/* Projects */}
                <div className="mt-4 px-3 space-y-0.5">
                    <Link href="/projects" className={navItemClass(pathname === "/projects")}>
                        <Briefcase className="w-4 h-4" />
                        Projects
                    </Link>
                    {activeProject && (
                        <Link
                            href={`/projects/${activeProject.id}`}
                            className={navItemClass(pathname.startsWith("/projects/") && pathname !== "/projects")}
                        >
                            <div className="w-4 h-4 rounded bg-linear-accent flex items-center justify-center">
                                <span className="text-[10px] font-bold text-white">
                                    {activeProject.name.charAt(0).toUpperCase()}
                                </span>
                            </div>
                            <span className="truncate">{activeProject.name}</span>
                        </Link>
                    )}
                </div>

                {/* Teams */}
                <div className="mt-4 px-3">
                    <button onClick={() => setTeamsExpanded(!teamsExpanded)} className={sectionHeaderClass}>
                        <span className={cn("transition-transform duration-200", teamsExpanded ? "" : "-rotate-90")}>
                            <ChevronDown className="w-3 h-3" />
                        </span>
                        Teams
                    </button>
                    <div
                        className={cn(
                            "overflow-hidden transition-all duration-200 ease-in-out",
                            teamsExpanded ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0"
                        )}
                    >
                        <div className="space-y-0.5">
                            <Link href="/team/engineering" className={navItemClass(pathname === "/team/engineering")}>
                                <div className="w-4 h-4 rounded bg-linear-bg-tertiary border border-linear-border flex items-center justify-center text-[10px] font-medium text-linear-text-secondary">
                                    E
                                </div>
                                Engineering
                            </Link>
                            <Link href="/team/design" className={navItemClass(pathname === "/team/design")}>
                                <div className="w-4 h-4 rounded bg-linear-bg-tertiary border border-linear-border flex items-center justify-center text-[10px] font-medium text-linear-text-secondary">
                                    D
                                </div>
                                Design
                            </Link>
                            <Link href="/team/product" className={navItemClass(pathname === "/team/product")}>
                                <div className="w-4 h-4 rounded bg-linear-bg-tertiary border border-linear-border flex items-center justify-center text-[10px] font-medium text-linear-text-secondary">
                                    P
                                </div>
                                Product
                            </Link>
                        </div>
                    </div>
                </div>

                {/* Favorites */}
                <div className="mt-4 px-3">
                    <button onClick={() => setFavoritesExpanded(!favoritesExpanded)} className={sectionHeaderClass}>
                        <span className={cn("transition-transform duration-200", favoritesExpanded ? "" : "-rotate-90")}>
                            <ChevronDown className="w-3 h-3" />
                        </span>
                        Favorites
                    </button>
                    <div
                        className={cn(
                            "overflow-hidden transition-all duration-200 ease-in-out",
                            favoritesExpanded ? "max-h-96 opacity-100 mt-1" : "max-h-0 opacity-0"
                        )}
                    >
                        <div className="space-y-0.5">
                            <Link href="/view/active" className={navItemClass(pathname === "/view/active")}>
                                <Circle className="w-3 h-3 text-linear-text-tertiary" />
                                Active Sprint
                            </Link>
                            <Link href="/view/backlog" className={navItemClass(pathname === "/view/backlog")}>
                                <Hash className="w-4 h-4 text-linear-text-tertiary" />
                                Backlog
                            </Link>
                        </div>
                    </div>
                </div>
            </nav>

            <div className="p-3 border-t border-linear-border min-w-0">
                <Link
                    href="/settings"
                    className={cn(
                        "flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium transition-all duration-200",
                        pathname === "/settings"
                            ? "bg-linear-bg-tertiary text-linear-text"
                            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                    )}
                >
                    <Settings className="w-4 h-4" />
                    Settings
                </Link>
            </div>

            {/* Auth Section */}
            <div className="p-3 border-t border-linear-border min-w-0">
                {isLoading ? (
                    <div className="flex items-center gap-3 px-3 py-2">
                        <div className="w-7 h-7 rounded-full bg-linear-bg-tertiary animate-pulse" />
                        <div className="h-3 w-20 bg-linear-bg-tertiary rounded animate-pulse" />
                    </div>
                ) : isAuthenticated && user ? (
                    <div className="flex items-center gap-3 px-3 py-2">
                        {user.avatarUrl && (
                            <img
                                src={user.avatarUrl}
                                alt={user.username}
                                className="w-7 h-7 rounded-full flex-shrink-0"
                            />
                        )}
                        <span className="text-sm text-linear-text truncate flex-1">{user.username}</span>
                        <button
                            onClick={logout}
                            className="p-1.5 rounded-md hover:bg-linear-bg-tertiary transition-colors text-linear-text-tertiary hover:text-linear-text"
                            title="Sign out"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                        </button>
                    </div>
                ) : (
                    <a
                        href={getLoginUrl()}
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium bg-linear-accent hover:bg-linear-accent-hover text-white transition-colors"
                    >
                        <Github className="w-4 h-4" />
                        Sign in with GitHub
                    </a>
                )}
            </div>
        </aside>
    )
}
