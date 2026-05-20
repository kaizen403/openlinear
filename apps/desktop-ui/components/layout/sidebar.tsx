"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { usePathname, useSearchParams, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
    Home, Inbox, Layers, Settings,
    PanelLeftClose, LogOut, Archive, Brain, BarChart3,
    ChevronRight, ChevronDown, CircleDot, Hexagon, MoreHorizontal, Pencil, Trash2, Plus,
    ChevronsUpDown, Building2,
    User as UserIcon, Sun, Moon, Monitor
} from "lucide-react"
import { ProjectSelector } from "@/components/auth/project-selector"
import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { cn } from "@/lib/utils"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { deleteTeam, apiFetch, type Team } from "@/lib/api"
import { getApiUrl, getAuthToken } from "@/lib/api/client"
import { useTeams } from "@/providers/teams-provider"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { buttonVariants } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const navItemClass = (isActive: boolean) =>
    cn(
        "flex items-center gap-3 px-3 py-1.5 rounded-sm text-sm font-medium transition-all duration-200 cursor-pointer group",
        isActive
            ? "bg-linear-bg-tertiary text-linear-text shadow-sm"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
    )

const subNavItemClass = (isActive: boolean) =>
    cn(
        "flex items-center gap-2.5 px-3 py-1 rounded-sm text-[13px] transition-all duration-200 cursor-pointer",
        isActive
            ? "bg-linear-bg-tertiary text-linear-text"
            : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
    )

interface SidebarProps {
    open: boolean
    onClose: () => void
    width: number
}

function TeamSection({ team, pathname, searchParams, onDelete }: { team: Team; pathname: string; searchParams: URLSearchParams; onDelete: (teamId: string, teamName: string) => void }) {
    const [expanded, setExpanded] = useState(true)
    const [menuOpen, setMenuOpen] = useState(false)
    const teamId = searchParams.get("teamId")

    const isIssuesActive = pathname === "/teams/issues" && searchParams.get("id") === team.id
    const isManageActive = pathname === "/teams/manage" && searchParams.get("id") === team.id

    return (
        <div className="group/team">
            <div className="flex items-center">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 rounded-sm text-[13px] font-medium text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors"
                >
                    {expanded ? (
                        <ChevronDown className="w-3 h-3 flex-shrink-0 text-linear-text-tertiary" />
                    ) : (
                        <ChevronRight className="w-3 h-3 flex-shrink-0 text-linear-text-tertiary" />
                    )}
                    {(() => {
                        const owner = team.members?.find(m => m.role === 'owner')
                        const avatarUrl = owner?.user?.avatarUrl
                        const fallbackChar = owner?.user?.username?.charAt(0)?.toUpperCase() || team.name.charAt(0).toUpperCase()
                        return avatarUrl ? (
                            <img src={avatarUrl} alt="" className="w-4 h-4 rounded-full flex-shrink-0 object-cover" />
                        ) : (
                            <div
                                className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
                                style={{ backgroundColor: `${team.color}25` }}
                            >
                                <span className="text-[9px] font-bold" style={{ color: team.color }}>
                                    {fallbackChar}
                                </span>
                            </div>
                        )
                    })()}
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
                            href={`/teams/manage?id=${team.id}`}
                            onClick={() => setMenuOpen(false)}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors w-full"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                            Edit
                        </Link>
                        <button
                            onClick={() => { setMenuOpen(false); onDelete(team.id, team.name) }}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-destructive hover:bg-destructive/10 transition-colors w-full"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                        </button>
                    </PopoverContent>
                </Popover>
            </div>

            {expanded && (
                <div className="ml-3 pl-3 border-l border-linear-border mt-0.5 space-y-0.5">
                    <Link
                        href={`/teams/issues?id=${team.id}&name=${encodeURIComponent(team.name)}`}
                        className={subNavItemClass(isIssuesActive)}
                    >
                        <CircleDot className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Issues</span>
                    </Link>
                    <Link
                        href={`/teams/manage?id=${team.id}`}
                        className={subNavItemClass(isManageActive)}
                    >
                        <Settings className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Manage</span>
                    </Link>
                </div>
            )}
        </div>
    )
}

function WorkspaceSwitcher() {
    const { activeWorkspace, workspaces, setActiveWorkspace, isLoading } = useWorkspace()
    const [isOpen, setIsOpen] = useState(false)

    if (isLoading || workspaces.length === 0) return null

    const initial = activeWorkspace?.name?.charAt(0).toUpperCase() ?? "W"

    return (
        <div className="px-3 pt-3 pb-2">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild>
                    <button className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-sm hover:bg-linear-bg-tertiary transition-colors">
                        <div className="w-5 h-5 rounded-sm bg-linear-bg-tertiary flex items-center justify-center text-[11px] font-semibold text-linear-text flex-shrink-0">
                            {initial}
                        </div>
                        <span className="flex-1 text-left truncate text-linear-text font-medium">
                            {activeWorkspace?.name || "Select workspace"}
                        </span>
                        <ChevronsUpDown className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-60 p-1" sideOffset={4}>
                    <div className="px-2 py-1.5 text-[11px] font-medium text-linear-text-tertiary uppercase tracking-wide">
                        Workspaces
                    </div>
                    {workspaces.map((workspace) => (
                        <button
                            key={workspace.id}
                            onClick={() => { setActiveWorkspace(workspace); setIsOpen(false) }}
                            className={cn(
                                "flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-sm transition-colors text-left",
                                workspace.id === activeWorkspace?.id
                                    ? "bg-linear-bg-tertiary text-linear-text"
                                    : "text-linear-text-secondary hover:bg-linear-bg-tertiary"
                            )}
                        >
                            <div className="w-5 h-5 rounded-sm bg-linear-bg-tertiary flex items-center justify-center text-[11px] font-semibold text-linear-text flex-shrink-0">
                                {workspace.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="flex-1 truncate">{workspace.name}</span>
                            {workspace.role === 'owner' && (
                                <span className="text-[10px] text-linear-text-tertiary uppercase tracking-wide">Owner</span>
                            )}
                        </button>
                    ))}
                    {activeWorkspace && (
                        <>
                            <div className="my-1 h-px bg-linear-border" />
                            <Link
                                href="/workspaces/manage"
                                onClick={() => setIsOpen(false)}
                                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-sm text-linear-text-secondary hover:bg-linear-bg-tertiary transition-colors"
                            >
                                <Settings className="w-3.5 h-3.5 flex-shrink-0" />
                                <span>Workspace settings</span>
                            </Link>
                        </>
                    )}
                </PopoverContent>
            </Popover>
        </div>
    )
}

function ProjectDropdown() {
    const { activeProject, projects, setActiveProject, isLoading } = useProject()
    const [isOpen, setIsOpen] = useState(false)

    if (isLoading || projects.length === 0) return null

    return (
        <div className="px-3 pb-2 border-b border-linear-border">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
                <PopoverTrigger asChild>
                    <button className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-sm hover:bg-linear-bg-tertiary transition-colors">
                        <Hexagon className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
                        <span className="flex-1 text-left truncate text-linear-text-secondary">
                            {activeProject?.name || "Select project"}
                        </span>
                        <ChevronsUpDown className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1" sideOffset={4}>
                    <div className="px-2 py-1.5 text-[11px] font-medium text-linear-text-tertiary uppercase tracking-wide">
                        Projects
                    </div>
                    {projects.map((project) => (
                        <button
                            key={project.id}
                            onClick={() => { setActiveProject(project); setIsOpen(false) }}
                            className={cn(
                                "flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-sm transition-colors text-left",
                                project.id === activeProject?.id
                                    ? "bg-linear-bg-tertiary text-linear-text"
                                    : "text-linear-text-secondary hover:bg-linear-bg-tertiary"
                            )}
                        >
                            <Hexagon className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{project.name}</span>
                        </button>
                    ))}
                </PopoverContent>
            </Popover>
        </div>
    )
}

export function Sidebar({ open, onClose, width }: SidebarProps) {
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const router = useRouter()
    const { user, isAuthenticated, isLoading, logout } = useAuth()
    const { teams, reload: reloadTeams } = useTeams()
    const { activeProject } = useProject()
    const { setTheme } = useTheme()

    const projectTeams = activeProject
        ? teams.filter(t => t.projectId === activeProject.id)
        : teams
    const [isTauri, setIsTauri] = useState(false)
    const [unreadCount, setUnreadCount] = useState<number>(0)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [eventSourceToken, setEventSourceToken] = useState<string | null>(null)

    useEffect(() => {
        const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
        setIsTauri(tauri)
        if (!tauri) return

        let unlisten: (() => void) | undefined

        const setup = async () => {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            const win = getCurrentWindow()
            setIsFullscreen(await win.isFullscreen())
            unlisten = await win.onResized(async () => {
                setIsFullscreen(await win.isFullscreen())
            })
        }
        setup()
        return () => { unlisten?.() }
    }, [])

    useEffect(() => {
        let cancelled = false
        apiFetch<{ unreadCount: number }>('/api/notifications?pageSize=1')
            .then((res) => { if (!cancelled) setUnreadCount(res.unreadCount) })
            .catch(() => { if (!cancelled) setUnreadCount(0) })
        return () => { cancelled = true }
    }, [pathname])

    useEffect(() => {
        if (typeof window === 'undefined') return
        setEventSourceToken(isAuthenticated ? getAuthToken() : null)
    }, [isAuthenticated, user])

    useEffect(() => {
        if (typeof window === 'undefined') return
        const handleStorage = (event: StorageEvent) => {
            if (event.key === 'token') {
                setEventSourceToken(isAuthenticated ? getAuthToken() : null)
            }
        }
        window.addEventListener('storage', handleStorage)
        return () => window.removeEventListener('storage', handleStorage)
    }, [isAuthenticated])

    useEffect(() => {
        if (typeof window === 'undefined') return
        if (!eventSourceToken) return
        const url = new URL(`${getApiUrl()}/api/events`)
        url.searchParams.set('token', eventSourceToken)
        const es = new EventSource(url.toString())
        const onCreated = () => setUnreadCount((c) => c + 1)
        es.addEventListener('notification:created', onCreated)
        return () => {
            es.removeEventListener('notification:created', onCreated)
            es.close()
        }
    }, [eventSourceToken])

    const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
    const [isDeletingTeam, setIsDeletingTeam] = useState(false)

    const handleDeleteTeam = useCallback((teamId: string, teamName: string) => {
        setDeleteTarget({ id: teamId, name: teamName })
    }, [])

    const confirmDeleteTeam = useCallback(async () => {
        if (!deleteTarget) return
        const { id: teamId } = deleteTarget
        try {
            setIsDeletingTeam(true)
            await deleteTeam(teamId)
            void reloadTeams()
            if (searchParams.get("teamId") === teamId || (pathname === "/teams/manage" && searchParams.get("id") === teamId)) {
                router.push('/')
            }
            setDeleteTarget(null)
        } catch (error) {
            console.error("Failed to delete team:", error)
        } finally {
            setIsDeletingTeam(false)
        }
    }, [deleteTarget, reloadTeams, searchParams, pathname, router])

    const handleClose = async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().close()
    }

    const handleMinimize = async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        getCurrentWindow().minimize()
    }

    const handleMaximize = async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const isMac = navigator.platform.toUpperCase().includes('MAC')
        if (isMac) {
            const win = getCurrentWindow()
            const fs = await win.isFullscreen()
            await win.setFullscreen(!fs)
        } else {
            getCurrentWindow().toggleMaximize()
        }
    }

    const isHomeNoFilter = pathname === "/" && !searchParams.get("teamId") && !searchParams.get("projectId")

    return (
        <aside
            className="bg-linear-bg-secondary border-r border-linear-border flex-shrink-0 overflow-hidden h-full relative"
            style={{ width: `${width}px` }}
            aria-hidden={!open}
        >
            <div className="flex flex-col h-full">
            <div className="p-4 border-b border-linear-border flex items-center justify-between min-w-0" data-tauri-drag-region>
                <div className="flex items-center gap-3">
                    {isTauri && (
                        <div className="flex items-center gap-[7px]">
                            <button
                                onClick={handleClose}
                                className="w-[12px] h-[12px] rounded-full hover:brightness-110 transition-all flex-shrink-0"
                                style={{ backgroundColor: BRAND_COLORS.macClose }}
                                aria-label="Close"
                            />
                            <button
                                onClick={handleMinimize}
                                className="w-[12px] h-[12px] rounded-full hover:brightness-110 transition-all flex-shrink-0"
                                style={{ backgroundColor: BRAND_COLORS.macMinimize }}
                                aria-label="Minimize"
                            />
                            <button
                                onClick={handleMaximize}
                                className="w-[12px] h-[12px] rounded-full hover:brightness-110 transition-all flex-shrink-0"
                                style={{ backgroundColor: BRAND_COLORS.macMaximize }}
                                aria-label="Maximize"
                            />
                        </div>
                    )}
                  <img src="/brand/logo.png" alt="OpenLinear" className="h-[20px]" />
                  <span className="text-sm font-semibold text-linear-text">OpenLinear</span>
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

            <WorkspaceSwitcher />
            <ProjectDropdown />

            <nav className="flex-1 overflow-y-auto py-2 min-w-0">
                <div className="px-3 space-y-0.5">
                    <Link href="/" className={navItemClass(isHomeNoFilter)}>
                        <Home className="w-4 h-4 flex-shrink-0" />
                        <span>Home</span>
                    </Link>
                    <Link href="/inbox" className={navItemClass(pathname === "/inbox")}>
                        <Inbox className="w-4 h-4 flex-shrink-0" />
                        <span>Inbox</span>
                        {unreadCount > 0 && (
                            <span className="ml-auto text-xs px-1.5 py-0.5 rounded text-linear-accent bg-linear-accent/10">
                                {unreadCount}
                            </span>
                        )}
                    </Link>
                    <Link href="/my-issues" className={navItemClass(pathname === "/my-issues")}>
                        <Layers className="w-4 h-4 flex-shrink-0" />
                        <span>My Issues</span>
                    </Link>

                </div>

                    <div className="mt-4 px-3">
                    <div className="flex items-center justify-between px-3 mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wider text-linear-text-tertiary">
                            Teams
                        </span>
                        <Link
                            href="/teams"
                            className="p-0.5 rounded hover:bg-linear-bg-tertiary transition-colors text-linear-text-tertiary hover:text-linear-text"
                            title="Manage all teams"
                        >
                            <Settings className="w-3.5 h-3.5" />
                        </Link>
                    </div>
                    {projectTeams.length > 0 ? (
                        <div className="space-y-0.5">
                            {projectTeams.map(team => (
                                <TeamSection
                                    key={team.id}
                                    team={team}
                                    pathname={pathname}
                                    searchParams={searchParams}
                                    onDelete={handleDeleteTeam}
                                />
                            ))}
                        </div>
                    ) : (
                        <Link
                            href="/teams"
                            className="flex items-center gap-2 px-3 py-1.5 rounded-sm text-[13px] text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors"
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
                    <Link href="/usage" className={navItemClass(pathname === "/usage")}>
                        <BarChart3 className="w-4 h-4 flex-shrink-0" />
                        <span>Usage</span>
                    </Link>
                    <Link href="/settings?section=ai-providers" className={navItemClass(pathname === "/settings" && searchParams.get("section") === "ai-providers")}>
                        <Brain className="w-4 h-4 flex-shrink-0" />
                        <span>Connect Provider</span>
                    </Link>
                </div>
            </nav>

            <div className="mt-auto p-3 border-t border-linear-border min-w-0">
                <Link
                    href="/settings"
                    className={cn(
                        "flex items-center gap-3 w-full px-3 py-2 rounded-sm text-sm font-medium transition-all duration-200",
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
                    <div className="flex items-center gap-3 px-2 py-2">
                        <div className="w-8 h-8 rounded-full bg-linear-bg-tertiary animate-pulse flex-shrink-0" />
                        <div className="flex-1 space-y-1.5">
                            <div className="h-3 w-24 bg-linear-bg-tertiary rounded animate-pulse" />
                            <div className="h-2.5 w-16 bg-linear-bg-tertiary/60 rounded animate-pulse" />
                        </div>
                    </div>
                ) : isAuthenticated && user ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md hover:bg-linear-bg-tertiary/60 transition-colors text-left group"
                                aria-label="User menu"
                            >
                                <div className="relative flex-shrink-0">
                                    <Avatar className="w-8 h-8 rounded-full ring-1 ring-linear-border">
                                        {user.avatarUrl && (
                                            <AvatarImage
                                                src={user.avatarUrl}
                                                alt={user.username}
                                                className="object-cover"
                                            />
                                        )}
                                        <AvatarFallback className="text-[11px] font-semibold bg-linear-bg-tertiary text-linear-text">
                                            {user.username.charAt(0).toUpperCase()}
                                        </AvatarFallback>
                                    </Avatar>
                                    <span
                                        aria-hidden
                                        className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-linear-bg-secondary"
                                    />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-linear-text truncate leading-tight">
                                        {user.username}
                                    </div>
                                    {user.email && (
                                        <div className="text-[11px] text-linear-text-tertiary truncate leading-tight mt-0.5">
                                            {user.email}
                                        </div>
                                    )}
                                </div>
                                <ChevronsUpDown className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" side="top" className="w-56">
                            <div className="flex items-center gap-2.5 px-2 py-2">
                                <Avatar className="w-9 h-9 rounded-full ring-1 ring-linear-border flex-shrink-0">
                                    {user.avatarUrl && (
                                        <AvatarImage
                                            src={user.avatarUrl}
                                            alt={user.username}
                                            className="object-cover"
                                        />
                                    )}
                                    <AvatarFallback className="text-xs font-semibold bg-linear-bg-tertiary text-linear-text">
                                        {user.username.charAt(0).toUpperCase()}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-linear-text truncate leading-tight">
                                        {user.username}
                                    </div>
                                    {user.email && (
                                        <div className="text-[11px] text-linear-text-tertiary truncate leading-tight mt-0.5">
                                            {user.email}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <Link href="/settings?section=profile" className="cursor-pointer">
                                    <UserIcon className="w-4 h-4 mr-2" />
                                    Profile
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Sun className="w-4 h-4 mr-2" />
                                    Theme
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem onClick={() => setTheme("light")} className="cursor-pointer">
                                        <Sun className="w-4 h-4 mr-2" />
                                        Light
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => setTheme("dark")} className="cursor-pointer">
                                        <Moon className="w-4 h-4 mr-2" />
                                        Dark
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => setTheme("system")} className="cursor-pointer">
                                        <Monitor className="w-4 h-4 mr-2" />
                                        System
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => logout()} className="cursor-pointer text-destructive focus:text-destructive">
                                <LogOut className="w-4 h-4 mr-2" />
                                Sign out
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <a
                        href="/login"
                        className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-sm text-sm font-medium bg-linear-accent hover:bg-linear-accent-hover text-white transition-colors"
                    >
                        <UserIcon className="w-4 h-4" />
                        Sign in
                    </a>
                )}
            </div>
            </div>

            <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete team</AlertDialogTitle>
                        <AlertDialogDescription>
                            Delete &ldquo;{deleteTarget?.name}&rdquo;? This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeletingTeam}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => { e.preventDefault(); void confirmDeleteTeam() }}
                            disabled={isDeletingTeam}
                            className={cn(buttonVariants({ variant: "destructive" }))}
                        >
                            {isDeletingTeam ? "Deleting..." : "Delete"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </aside>
    )
}
