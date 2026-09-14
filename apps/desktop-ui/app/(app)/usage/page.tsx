"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import {
  BarChart3, DollarSign, Activity, Coins, Loader2,
  ArrowUpDown, ChevronDown, ExternalLink,
} from "lucide-react"
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"

interface UsageSummary {
  totalCostUsd: number
  totalRuns: number
  totalInputTokens: number
  totalOutputTokens: number
  avgCostPerRun: number
  daily: { date: string; costUsd: number; runs: number }[]
}

interface ByTaskRow {
  taskId: string
  taskTitle: string
  taskIdentifier: string | null
  runs: number
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  lastRunAt: string | null
}

interface ByTaskResponse {
  items: ByTaskRow[]
  page: number
  pageSize: number
  total: number
  sort: SortKey
}

type SortKey = 'cost' | 'runs' | 'recent'

function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatRelativeDate(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatChartDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface ChartTooltipPayload {
  payload: { date: string; costUsd: number; runs: number }
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: ChartTooltipPayload[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="bg-linear-bg-secondary border border-linear-border rounded-sm px-3 py-2 shadow-xl">
      <div className="text-[11px] text-linear-text-tertiary mb-1">{formatChartDate(p.date)}</div>
      <div className="text-sm font-mono text-linear-text">{formatUsd(p.costUsd)}</div>
      <div className="text-[11px] text-linear-text-secondary">{p.runs} {p.runs === 1 ? 'run' : 'runs'}</div>
    </div>
  )
}

function StatCard({
  icon: Icon, label, value, sublabel, accent,
}: {
  icon: typeof DollarSign
  label: string
  value: string
  sublabel?: string
  accent: string
}) {
  return (
    <div className="bg-linear-bg-secondary border border-linear-border rounded-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] uppercase tracking-wider font-semibold text-linear-text-tertiary">
          {label}
        </span>
        <div className={cn("w-7 h-7 rounded-sm flex items-center justify-center", accent)}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className="text-2xl font-semibold text-linear-text font-mono">{value}</div>
      {sublabel && <div className="text-[11px] text-linear-text-tertiary mt-1">{sublabel}</div>}
    </div>
  )
}

const sortLabels: Record<SortKey, string> = {
  cost: 'Highest cost',
  runs: 'Most runs',
  recent: 'Most recent',
}

export default function UsagePage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [byTask, setByTask] = useState<ByTaskResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortKey>('cost')
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)

  const loadSummary = useCallback(async () => {
    try {
      const data = await apiFetch<UsageSummary>('/api/usage/summary')
      setSummary(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage summary')
    }
  }, [])

  const loadByTask = useCallback(async (s: SortKey, p: number) => {
    try {
      const qs = new URLSearchParams({ sort: s, page: String(p), pageSize: '25' })
      const data = await apiFetch<ByTaskResponse>(`/api/usage/by-task?${qs}`)
      setByTask(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load per-task usage')
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadSummary(), loadByTask(sort, page)]).finally(() => setLoading(false))
  }, [loadSummary, loadByTask, sort, page])

  const totalPages = useMemo(
    () => (byTask ? Math.max(1, Math.ceil(byTask.total / byTask.pageSize)) : 1),
    [byTask],
  )

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-3" data-tauri-drag-region>
        <BarChart3 className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
        <h1 className="text-lg font-semibold">Usage</h1>
        <span className="text-xs text-linear-text-tertiary bg-linear-bg-tertiary px-1.5 py-0.5 rounded">
          last 30 days
        </span>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        {loading && !summary ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-linear-text-tertiary">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        ) : summary ? (
          <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                icon={DollarSign}
                label="Total cost"
                value={formatUsd(summary.totalCostUsd)}
                sublabel="last 30 days"
                accent="bg-linear-accent/10 text-linear-accent"
              />
              <StatCard
                icon={Activity}
                label="Total runs"
                value={summary.totalRuns.toLocaleString()}
                sublabel={`avg ${formatUsd(summary.avgCostPerRun)} / run`}
                accent="bg-linear-accent/10 text-linear-accent"
              />
              <StatCard
                icon={Coins}
                label="Input tokens"
                value={formatNumber(summary.totalInputTokens)}
                accent="bg-violet-500/10 text-violet-400"
              />
              <StatCard
                icon={Coins}
                label="Output tokens"
                value={formatNumber(summary.totalOutputTokens)}
                accent="bg-amber-500/10 text-amber-400"
              />
            </div>

            <section className="bg-linear-bg-secondary border border-linear-border rounded-sm p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-linear-text">Cost over time</h2>
                  <p className="text-[11px] text-linear-text-tertiary mt-0.5">Daily AI spend across all tracked agent runs</p>
                </div>
              </div>
              <div className="h-64 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={summary.daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--linear-accent)" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="var(--linear-accent)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatChartDate}
                      stroke="rgba(255,255,255,0.3)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={32}
                    />
                    <YAxis
                      stroke="rgba(255,255,255,0.3)"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => formatUsd(v)}
                      width={60}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
                    <Area
                      type="monotone"
                      dataKey="costUsd"
                      stroke="var(--linear-accent)"
                      strokeWidth={2}
                      fill="url(#costGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="bg-linear-bg-secondary border border-linear-border rounded-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-linear-border">
                <div>
                  <h2 className="text-sm font-semibold text-linear-text">By task</h2>
                  <p className="text-[11px] text-linear-text-tertiary mt-0.5">
                    {byTask?.total ?? 0} tasks with agent runs
                  </p>
                </div>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setSortMenuOpen((v) => !v)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-xs text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary transition-colors border border-linear-border"
                  >
                    <ArrowUpDown className="w-3 h-3" />
                    {sortLabels[sort]}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {sortMenuOpen && (
                    <div className="absolute right-0 top-full mt-1 w-40 bg-linear-bg-secondary border border-linear-border rounded-sm shadow-xl z-10 p-1">
                      {(Object.keys(sortLabels) as SortKey[]).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => { setSort(k); setPage(1); setSortMenuOpen(false) }}
                          className={cn(
                            "block w-full text-left px-2 py-1.5 rounded text-xs transition-colors",
                            sort === k
                              ? "bg-linear-bg-tertiary text-linear-text"
                              : "text-linear-text-secondary hover:bg-linear-bg-tertiary/60 hover:text-linear-text",
                          )}
                        >
                          {sortLabels[k]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {byTask && byTask.items.length > 0 ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wider text-linear-text-tertiary border-b border-linear-border">
                          <th className="text-left font-medium px-4 py-2">Task</th>
                          <th className="text-right font-medium px-4 py-2">Runs</th>
                          <th className="text-right font-medium px-4 py-2">Cost</th>
                          <th className="text-right font-medium px-4 py-2 hidden md:table-cell">Input</th>
                          <th className="text-right font-medium px-4 py-2 hidden md:table-cell">Output</th>
                          <th className="text-right font-medium px-4 py-2 hidden sm:table-cell">Last run</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {byTask.items.map((row) => (
                          <tr key={row.taskId} className="hover:bg-white/[0.02] transition-colors group">
                            <td className="px-4 py-2.5 max-w-md">
                              <div className="flex items-center gap-2 min-w-0">
                                {row.taskIdentifier && (
                                  <span className="text-[11px] text-linear-text-tertiary font-mono flex-shrink-0">
                                    {row.taskIdentifier}
                                  </span>
                                )}
                                <span className="truncate text-linear-text">{row.taskTitle}</span>
                                <a
                                  href={`/?taskId=${row.taskId}`}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity text-linear-text-tertiary hover:text-linear-text"
                                  title="Open task"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-linear-text-secondary">
                              {row.runs}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-linear-accent">
                              {formatUsd(row.totalCostUsd)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-linear-text-tertiary hidden md:table-cell">
                              {formatNumber(row.totalInputTokens)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-linear-text-tertiary hidden md:table-cell">
                              {formatNumber(row.totalOutputTokens)}
                            </td>
                            <td className="px-4 py-2.5 text-right text-[11px] text-linear-text-tertiary hidden sm:table-cell">
                              {formatRelativeDate(row.lastRunAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-linear-border text-xs text-linear-text-tertiary">
                      <span>Page {byTask.page} of {totalPages}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          disabled={byTask.page <= 1}
                          className="px-2 py-1 rounded border border-linear-border hover:bg-linear-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          disabled={byTask.page >= totalPages}
                          className="px-2 py-1 rounded border border-linear-border hover:bg-linear-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-linear-text-tertiary">
                  <BarChart3 className="w-8 h-8 mb-2 opacity-40" />
                  <p className="text-sm">No agent runs yet</p>
                  <p className="text-xs mt-1 opacity-60">Execute a task to start tracking cost and tokens</p>
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </>
  )
}
