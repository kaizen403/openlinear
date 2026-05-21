"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { usePathname, useSearchParams, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
    Home, Inbox, Layers, Settings,
    PanelLeftClose, LogOut, Archive, Brain, BarChart3,
    ChevronRight, ChevronDown, Hexagon, Plus,
    ChevronsUpDown, Building2, Users, FolderKanban,
    User as UserIcon, Sun, Moon, Monitor
} from "lucide-react"

import { useAuth } from "@/hooks/use-auth"
import { useProject } from "@/hooks/use-project"
import { useWorkspace } from "@/hooks/use-workspace"
import { cn } from "@/lib/utils"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { apiFetch } from "@/lib/api"
import { getApiUrl, getAuthToken } from "@/lib/api/client"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

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

function ProjectSection({ project, pathname, searchParams, isActive, onSelect }: {
    project: { id: string; name: string };
    pathname: string;
    searchParams: URLSearchParams;
    isActive: boolean;
    onSelect: () => void;
}) {
    const [expanded, setExpanded] = useState(isActive)

    useEffect(() => {
        if (isActive) setExpanded(true)
    }, [isActive])

    const isIssuesActive = pathname === "/projects/issues" && searchParams.get("id") === project.id
    const isTeamsActive = (pathname === "/teams" || pathname === "/teams/issues" || pathname === "/teams/manage") && searchParams.get("projectId") === project.id
    const isSettingsActive = pathname === "/projects/manage" && searchParams.get("id") === project.id

    return (
        <div>
            <div className="flex items-center group">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="p-0.5 rounded hover:bg-linear-bg-tertiary transition-colors text-linear-text-tertiary"
                >
                    {expanded ? (
                        <ChevronDown className="w-3 h-3" />
                    ) : (
                        <ChevronRight className="w-3 h-3" />
                    )}
                </button>
                <button
                    onClick={onSelect}
                    className={cn(
                        "flex items-center gap-2 flex-1 px-2 py-1 rounded-sm text-sm font-medium transition-all duration-200 text-left",
                        isActive
                            ? "text-linear-text"
                            : "text-linear-text-secondary hover:text-linear-text"
                    )}
                >
                    <Hexagon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{project.name}</span>
                </button>
            </div>

            {expanded && (
                <div className="ml-3 pl-3 border-l border-linear-border mt-0.5 space-y-0.5">
                    <Link
                        href={`/projects/issues?id=${project.id}&name=${encodeURIComponent(project.name)}`}
                        onClick={onSelect}
                        className={subNavItemClass(isIssuesActive)}
                    >
                        <FolderKanban className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Issues</span>
                    </Link>
                    <Link
                        href={`/teams?projectId=${project.id}`}
                        className={subNavItemClass(isTeamsActive)}
                    >
                        <Users className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Teams</span>
                    </Link>
                    <Link
                        href={`/projects/manage?id=${project.id}`}
                        className={subNavItemClass(isSettingsActive)}
                    >
                        <Settings className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Settings</span>
                    </Link>
                </div>
            )}
        </div>
    )
}

export function Sidebar({ open, onClose, width }: SidebarProps) {
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const router = useRouter()
    const { user, isAuthenticated, isLoading, logout } = useAuth()
    const { activeProject, projects, setActiveProject } = useProject()
    const { setTheme } = useTheme()
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
                            Projects
                        </span>
                        <Link
                            href="/projects"
                            className="p-0.5 rounded hover:bg-linear-bg-tertiary transition-colors text-linear-text-tertiary hover:text-linear-text"
                            title="Manage all projects"
                        >
                            <Settings className="w-3.5 h-3.5" />
                        </Link>
                    </div>
                    {projects.length > 0 ? (
                        <div className="space-y-0.5">
                            {projects.map(project => (
                                <ProjectSection
                                    key={project.id}
                                    project={project}
                                    pathname={pathname}
                                    searchParams={searchParams}
                                    isActive={activeProject?.id === project.id}
                                    onSelect={() => setActiveProject(project)}
                                />
                            ))}
                        </div>
                    ) : (
                        <Link
                            href="/projects"
                            className="flex items-center gap-2 px-3 py-1.5 rounded-sm text-[13px] text-linear-text-tertiary hover:text-linear-text hover:bg-linear-bg-tertiary/50 transition-colors"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Create a project</span>
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
        </aside>
    )
}
