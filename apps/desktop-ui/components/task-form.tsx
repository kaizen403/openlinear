"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Loader2, FolderKanban, Users } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LabelPicker } from "@/components/label-picker"
import { DatePicker } from "@/components/ui/date-picker"
import { TaskFormModelSelector } from "@/components/task-form-model-selector"
import { Project } from "@/lib/api"
import { useTeams } from "@/providers/teams-provider"
import { useProject } from "@/hooks/use-project"
import type { Task } from "@/types/task"

const getFormSchema = (hasProjects: boolean) => z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done", "cancelled"]),
  labelIds: z.array(z.string()),
  projectId: hasProjects ? z.string().min(1, "Project is required") : z.string().optional(),
  teamId: z.string().optional(),
  dueDate: z.string().optional(),
  model: z.string().nullable().optional(),
})

type FormValues = z.infer<ReturnType<typeof getFormSchema>>

interface TaskFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: (task: Task) => void
  defaultStatus?: "todo" | "in_progress" | "done" | "cancelled"
  defaultProjectId?: string | null
  projects?: Project[]
}

import { apiFetch, ApiError } from "@/lib/api/fetch"
import { toast } from "sonner"
import { STATUS_COLORS } from "@/lib/design-tokens"

const statusLabels = {
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
}

export function TaskFormDialog({
  open,
  onOpenChange,
  onSuccess,
  defaultStatus,
  defaultProjectId,
  projects = [],
}: TaskFormDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const hasProjects = projects.length > 0
  const { teams } = useTeams()
  const { activeProject } = useProject()

  const effectiveProjectId = defaultProjectId || activeProject?.id || null
  const projectTeams = effectiveProjectId
    ? teams.filter(t => t.projectId === effectiveProjectId)
    : teams
  const defaultFormValues = useMemo<FormValues>(() => ({
    title: "",
    description: "",
    status: defaultStatus || "todo",
    labelIds: [],
    projectId: defaultProjectId || (hasProjects ? "" : undefined),
    teamId: "",
    dueDate: "",
    model: null,
  }), [defaultProjectId, defaultStatus, hasProjects])

  const form = useForm<FormValues>({
    resolver: zodResolver(getFormSchema(hasProjects)),
    defaultValues: defaultFormValues,
  })

  useEffect(() => {
    if (open) {
      form.reset(defaultFormValues)
    }
  }, [defaultFormValues, form, open])

  const resetAfterClose = useCallback(() => {
    window.setTimeout(() => form.reset(defaultFormValues), 0)
  }, [defaultFormValues, form])

  const onSubmit = useCallback(async (values: FormValues) => {
    try {
      setIsSubmitting(true)

      const created = await apiFetch<Task>('/api/tasks', {
        method: "POST",
        body: JSON.stringify({
          title: values.title,
          description: values.description || undefined,
          status: values.status,
          labelIds: values.labelIds.length > 0 ? values.labelIds : undefined,
          projectId: values.projectId || undefined,
          teamId: values.teamId || undefined,
          dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : undefined,
          model: values.model || undefined,
        }),
      })

      onOpenChange(false)
      resetAfterClose()
      onSuccess?.(created)
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(error.message)
        const details = error.details as
          | { fieldErrors?: Record<string, string[]> }
          | undefined
        if (details?.fieldErrors && typeof details.fieldErrors === "object") {
          for (const [field, msgs] of Object.entries(details.fieldErrors)) {
            if (Array.isArray(msgs) && msgs.length > 0 && typeof msgs[0] === "string") {
              if (field === "title" || field === "description" || field === "status" || field === "projectId" || field === "dueDate") {
                form.setError(field as keyof FormValues, { type: "server", message: msgs[0] })
              }
            }
          }
        } else {
          form.setError("root", { type: "server", message: error.message })
        }
      } else {
        toast.error("Could not reach OpenLinear server. Check your connection and try again.")
        form.setError("root", { type: "server", message: "Network error" })
      }
    } finally {
      setIsSubmitting(false)
    }
  }, [form, onOpenChange, onSuccess, resetAfterClose])

  // ⌘+Enter keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && open) {
        e.preventDefault()
        form.handleSubmit(onSubmit)()
      }
    }

    if (open) {
      window.addEventListener("keydown", handleKeyDown)
      return () => window.removeEventListener("keydown", handleKeyDown)
    }
  }, [open, form, onSubmit])

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen)
    if (!newOpen) {
      resetAfterClose()
    }
  }

  const handleTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget
    target.style.height = "auto"
    target.style.height = Math.min(target.scrollHeight, 200) + "px"
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px] bg-linear-bg-secondary border-linear-border p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Create Task</DialogTitle>
        <DialogDescription className="sr-only">
          Create a new task with title, description, due date, and labels
        </DialogDescription>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col">
            <div className="px-4 sm:px-5 pt-4 pb-3">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="space-y-0">
                    <FormControl>
                      <input
                        type="text"
                        placeholder="Issue title"
                        className="w-full bg-transparent text-lg font-semibold text-linear-text placeholder:text-linear-text-tertiary outline-none border-none focus:ring-0 p-0"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs mt-1" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="space-y-0 mt-2">
                    <FormControl>
                      <textarea
                        placeholder="Add description..."
                        className="w-full bg-transparent text-sm text-linear-text-secondary placeholder:text-linear-text-tertiary outline-none border-none resize-none focus:ring-0 p-0 min-h-[60px] max-h-[200px] overflow-y-auto"
                        rows={1}
                        onInput={handleTextareaInput}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs mt-1" />
                  </FormItem>
                )}
              />
            </div>

            <div className="border-b border-linear-border" />

            <div className="px-4 sm:px-5 py-3 flex items-center gap-2 flex-wrap">
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="space-y-0">
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary text-linear-text-secondary gap-1.5 focus:ring-0 shadow-none">
                          <div className="flex items-center gap-1.5">
                            <div
                              className={cn("w-2 h-2 rounded-full", STATUS_COLORS[field.value as keyof typeof STATUS_COLORS]?.dot ?? "bg-muted-foreground")}
                            />
                            <SelectValue placeholder="Status">
                              {statusLabels[field.value as keyof typeof statusLabels]}
                            </SelectValue>
                          </div>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="bg-linear-bg-secondary border-linear-border">
                        <SelectItem
                          value="todo"
                          className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className={cn("w-2 h-2 rounded-full", STATUS_COLORS.todo.dot)} />
                            Todo
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="in_progress"
                          className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className={cn("w-2 h-2 rounded-full", STATUS_COLORS.in_progress.dot)} />
                            In Progress
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="done"
                          className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className={cn("w-2 h-2 rounded-full", STATUS_COLORS.done.dot)} />
                            Done
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="cancelled"
                          className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className={cn("w-2 h-2 rounded-full", STATUS_COLORS.cancelled.dot)} />
                            Cancelled
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage className="text-red-400 text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="labelIds"
                render={({ field }) => (
                  <FormItem className="space-y-0">
                    <FormControl>
                      <LabelPicker
                        projectId={effectiveProjectId || ""}
                        selectedIds={field.value}
                        onChange={field.onChange}
                        triggerClassName="h-7 w-auto px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary hover:border-none text-linear-text-secondary shadow-none"
                      />
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem className="space-y-0">
                    <FormControl>
                      <DatePicker
                        value={field.value || ""}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="model"
                render={({ field }) => (
                  <FormItem className="space-y-0">
                    <FormControl>
                      <TaskFormModelSelector
                        value={field.value ?? null}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs" />
                  </FormItem>
                )}
              />

              {projectTeams.length > 0 && (
                <FormField
                  control={form.control}
                  name="teamId"
                  render={({ field }) => (
                    <FormItem className="space-y-0">
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || ""}
                      >
                        <FormControl>
                          <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary text-linear-text-secondary gap-1.5 focus:ring-0 shadow-none">
                            <div className="flex items-center gap-1.5">
                              <Users className="w-3 h-3 text-linear-text-tertiary" />
                              <SelectValue placeholder="Team">
                                {field.value
                                  ? projectTeams.find((t) => t.id === field.value)?.name
                                  : "Team"}
                              </SelectValue>
                            </div>
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="bg-linear-bg-secondary border-linear-border">
                          {projectTeams.map((team) => (
                            <SelectItem
                              key={team.id}
                              value={team.id}
                              className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <div
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: team.color }}
                                />
                                {team.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-red-400 text-xs" />
                    </FormItem>
                  )}
                />
              )}

              {hasProjects && !defaultProjectId && (
                <FormField
                  control={form.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem className="space-y-0">
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || ""}
                      >
                        <FormControl>
                          <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary text-linear-text-secondary gap-1.5 focus:ring-0 shadow-none data-[state=error]:border-red-500">
                            <div className="flex items-center gap-1.5">
                              <FolderKanban className="w-3 h-3 text-linear-text-tertiary" />
                              <SelectValue placeholder="Select project">
                                {field.value
                                  ? projects.find((p) => p.id === field.value)?.name
                                  : "Select project"}
                              </SelectValue>
                            </div>
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="bg-linear-bg-secondary border-linear-border">
                          {projects.map((project) => (
                            <SelectItem
                              key={project.id}
                              value={project.id}
                              className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <div
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: project.color }}
                                />
                                {project.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-red-400 text-xs" />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <div className="border-b border-linear-border" />

            {form.formState.errors.root?.message && (
              <div className="px-4 sm:px-5 pt-2 text-xs text-red-400">
                {form.formState.errors.root.message}
              </div>
            )}

            <DialogFooter className="px-4 sm:px-5 py-3 gap-2 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={isSubmitting}
                className="h-8 px-3 text-xs bg-transparent text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text"
              >
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-linear-text-tertiary">⌘ Enter</span>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-8 px-3 text-xs bg-linear-accent hover:bg-linear-accent-hover text-white"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create Task"
                  )}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
