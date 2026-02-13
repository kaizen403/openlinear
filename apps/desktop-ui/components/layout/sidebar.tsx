"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { usePathname, useSearchParams, useRouter } from "next/navigation"
import {
    Home, Inbox, Layers, Settings,
    PanelLeftClose, LogOut, Archive,
    ChevronRight, ChevronDown, CircleDot, Hexagon, MoreHorizontal, Pencil, Trash2, Plus
} from "lucide-react"
import { ProjectSelector } from "@/components/auth/project-selector"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import { fetchInboxCount, fetchTeams, deleteTeam, type Team } from "@/lib/api"
import { useSSESubscription } from "@/providers/sse-provider"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

// Module-level cache so teams survive sidebar remounts during page navigation
let cachedTeams: Team[] = []

const navItemClass = (isActive: boolean) =>
    cn(
        "flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer group",
        isActive
            ? "bg-linear-bg-tertiary text-linear-text shadow-sm"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
    )

const subNavItemClass = (isActive: boolean) =>
    cn(
        "flex items-center gap-2.5 px-3 py-1 rounded-md text-[13px] transition-all duration-200 cursor-pointer",
        isActive
            ? "bg-linear-bg-tertiary text-linear-text"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
    )

interface SidebarProps {
    open: boolean
    onClose: () => void
    width: number
    animating: boolean
}

function TeamSection({ team, pathname, searchParams, onDelete }: { team: Team; pathname: string; searchParams: URLSearchParams; onDelete: (teamId: string, teamName: string) => void }) {
    const [expanded, setExpanded] = useState(true)
    const [menuOpen, setMenuOpen] = useState(false)
    const teamId = searchParams.get("teamId")

    const isIssuesActive = pathname === "/" && teamId === team.id
    const isProjectsActive = pathname === "/projects" && teamId === team.id

    return (
        <div className="group/team">
            <div className="flex items-center">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 rounded-md text-[13px] font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors"
                >
                    {expanded ? (
                        <ChevronDown className="w-3 h-3 flex-shrink-0 text-linear-text-tertiary" />
                    ) : (
                        <ChevronRight className="w-3 h-3 flex-shrink-0 text-linear-text-tertiary" />
                    )}
                    <div
                        className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: `${team.color}25` }}
                    >
                        <span className="text-[9px] font-bold" style={{ color: team.color }}>
                            {team.name.charAt(0).toUpperCase()}
                        </span>
                    </div>
                    <span className="truncate">{team.name}</span>
                </button>
                <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                    <PopoverTrigger asChild>
                        <button
                            className="opacity-0 group-hover/team:opacity-100 p-1 mr-2 rounded hover:bg-linear-bg-tertiary transition-all text-linear-text-tertiary hover:text-linear-text"
                            title="Team options"
                        >
                            <MoreHorizontal className="w-3 h-3" />
                        </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" side="bottom" className="w-36 p-1 bg-linear-bg-secondary border-linear-border">
                        <Link
                            href={`/teams/${team.id}`}
                            onClick={() => setMenuOpen(false)}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors w-full"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                            Edit
                        </Link>
                        <button
                            onClick={() => { setMenuOpen(false); onDelete(team.id, team.name) }}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-red-500 hover:bg-red-500/10 transition-colors w-full"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                        </button>
                    </PopoverContent>
                </Popover>
            </div>

            {expanded && (
                <div className="ml-3 pl-3 border-l border-white/[0.06] mt-0.5 space-y-0.5">
                    <Link
                        href={`/?teamId=${team.id}`}
                        className={subNavItemClass(isIssuesActive)}
                    >
                        <CircleDot className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Issues</span>
                    </Link>
                    <Link
                        href={`/projects?teamId=${team.id}`}
                        className={subNavItemClass(isProjectsActive)}
                    >
                        <Hexagon className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Projects</span>
                    </Link>
                </div>
            )}
        </div>
    )
}

export function Sidebar({ open, onClose, width, animating }: SidebarProps) {
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const router = useRouter()
    const { user, isAuthenticated, isLoading, logout } = useAuth()
    const [isTauri, setIsTauri] = useState(false)
    const [inboxCount, setInboxCount] = useState<{ total: number; unread: number }>({ total: 0, unread: 0 })
    const [teams, setTeams] = useState<Team[]>(cachedTeams)

    const loadTeams = useCallback(() => {
        fetchTeams().then((data) => {
            cachedTeams = data
            setTeams(data)
        }).catch(() => setTeams([]))
    }, [])

    useEffect(() => {
        setIsTauri(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
    }, [])

    useEffect(() => {
        fetchInboxCount().then(setInboxCount).catch(() => setInboxCount({ total: 0, unread: 0 }))
    }, [pathname])

    useEffect(() => {
        loadTeams()
    }, [loadTeams])

    useSSESubscription((eventType) => {
        if (['team:created', 'team:updated', 'team:deleted'].includes(eventType)) {
            loadTeams()
        }
    })

    const handleDeleteTeam = useCallback(async (teamId: string, teamName: string) => {
        if (!confirm(`Delete "${teamName}"? This action cannot be undone.`)) return
        try {
            await deleteTeam(teamId)
            loadTeams()
            if (searchParams.get("teamId") === teamId || pathname.startsWith(`/teams/${teamId}`)) {
                router.push('/')
            }
        } catch (error) {
            console.error("Failed to delete team:", error)
        }
    }, [loadTeams, searchParams, pathname, router])

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

    const isHomeNoFilter = pathname === "/" && !searchParams.get("teamId") && !searchParams.get("projectId")

    return (
        <aside
            className="bg-linear-bg-secondary border-r border-linear-border flex flex-col flex-shrink-0 overflow-hidden h-full"
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
                    <span className="text-base font-semibold text-linear-text">KazCode</span>
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

            <nav className="flex-1 overflow-y-auto py-2 min-w-0">
                <div className="px-3 space-y-0.5">
                    <Link href="/" className={navItemClass(isHomeNoFilter)}>
                        <Home className="w-4 h-4 flex-shrink-0" />
                        <span>Home</span>
                    </Link>
                    <Link href="/inbox" className={navItemClass(pathname === "/inbox")}>
                        <Inbox className="w-4 h-4 flex-shrink-0" />
                        <span>Inbox</span>
                        {inboxCount.total > 0 && (
                            <span className={cn(
                                "ml-auto text-xs px-1.5 py-0.5 rounded",
                                inboxCount.unread > 0
                                    ? "text-linear-accent bg-linear-accent/10"
                                    : "text-linear-text-tertiary bg-linear-bg-tertiary"
                            )}>
                                {inboxCount.total}
                            </span>
                        )}
                    </Link>
                    <Link href="/my-issues" className={navItemClass(pathname === "/my-issues")}>
                        <Layers className="w-4 h-4 flex-shrink-0" />
                        <span>My Issues</span>
                    </Link>

                </div>

                {/* Team hierarchy */}
                <div className="mt-4 px-3">
                    <div className="flex items-center justify-between px-3 mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wider text-linear-text-tertiary">
                            Your teams
                        </span>
                        <Link
                            href="/teams"
                            className="p-0.5 rounded hover:bg-linear-bg-tertiary transition-colors text-linear-text-tertiary hover:text-linear-text"
                            title="Manage teams"
                        >
                            <Settings className="w-3.5 h-3.5" />
                        </Link>
                    </div>
                    {teams.length > 0 ? (
                        <div className="space-y-0.5">
                            {teams.map(team => (
                                <TeamSection
                                    key={team.id}
                                    team={team}
                                    pathname={pathname}
                                    searchParams={searchParams}
                                    onDelete={handleDeleteTeam}
                                />
                            ))}
                            <Link
                                href="/teams"
                                className={subNavItemClass(pathname === "/teams")}
                            >
                                <Settings className="w-3.5 h-3.5 flex-shrink-0" />
                                <span>Manage</span>
                            </Link>
                        </div>
                    ) : (
                        <Link
                            href="/teams"
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Create a team</span>
                        </Link>
                    )}
                </div>

                <div className="mt-4 px-3 space-y-0.5">
                    <Link href="/archived" className={navItemClass(pathname === "/archived")}>
                        <Archive className="w-4 h-4 flex-shrink-0" />
                        <span>Archived</span>
                    </Link>
                </div>
            </nav>

            <div className="mt-auto p-3 border-t border-linear-border min-w-0">
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
                        href="/login"
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium bg-linear-accent hover:bg-linear-accent-hover text-white transition-colors"
                    >
                        Sign in
                    </a>
                )}
            </div>
        </aside>
    )
}
