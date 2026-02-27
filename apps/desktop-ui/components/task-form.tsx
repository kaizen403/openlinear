"use client"

import { useState, useEffect } from "react"
import { Loader2, FolderKanban, CalendarDays } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"

import { Button } from "@/components/ui/button"
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
import { Project } from "@/lib/api"

const getFormSchema = (hasProjects: boolean) => z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done", "cancelled"]),
  labelIds: z.array(z.string()),
  projectId: hasProjects ? z.string().min(1, "Project is required") : z.string().optional(),
  dueDate: z.string().optional(),
})

type FormValues = z.infer<ReturnType<typeof getFormSchema>>

interface TaskFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
  defaultStatus?: "todo" | "in_progress" | "done" | "cancelled"
  defaultProjectId?: string | null
  defaultTeamId?: string | null
  projects?: Project[]
}

import { API_URL, getAuthHeader } from "@/lib/api/client"

const API_BASE_URL = `${API_URL}/api`

const statusColors = {
  todo: "#a0a0a0",
  in_progress: "#f59e0b",
  done: "#22c55e",
  cancelled: "#ef4444",
}

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
  defaultTeamId,
  projects = [],
}: TaskFormDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const hasProjects = projects.length > 0

  const form = useForm<FormValues>({
    resolver: zodResolver(getFormSchema(hasProjects)),
    defaultValues: {
      title: "",
      description: "",
      status: defaultStatus || "todo",
      labelIds: [],
      projectId: defaultProjectId || (hasProjects ? "" : undefined),
      dueDate: "",
    },
  })

  useEffect(() => {
    if (open) {
      form.setValue("status", defaultStatus || "todo")
      form.setValue("projectId", defaultProjectId || (hasProjects ? "" : undefined))
    }
  }, [defaultStatus, defaultProjectId, open, form, hasProjects])

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
  }, [open, form])

  const onSubmit = async (values: FormValues) => {
    try {
      setIsSubmitting(true)

      const response = await fetch(`${API_BASE_URL}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeader(),
        },
         body: JSON.stringify({
           title: values.title,
           description: values.description || undefined,
           status: values.status,
           labelIds: values.labelIds.length > 0 ? values.labelIds : undefined,
           projectId: values.projectId || undefined,
           teamId: values.projectId ? undefined : (defaultTeamId || undefined),
           dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : undefined,
         }),
      })

      if (!response.ok) {
        throw new Error(`Failed to create task: ${response.statusText}`)
      }

      form.reset()
      onOpenChange(false)
      onSuccess?.()
    } catch (error) {
      console.error("Error creating task:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      form.reset()
    }
    onOpenChange(newOpen)
  }

  const handleTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget
    target.style.height = "auto"
    target.style.height = Math.min(target.scrollHeight, 200) + "px"
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px] bg-[#1a1a1a] border-[#2a2a2a] p-0 gap-0 overflow-hidden">
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
                        className="w-full bg-transparent text-lg font-semibold text-[#f5f5f5] placeholder:text-[#6a6a6a] outline-none border-none focus:ring-0 p-0"
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
                        className="w-full bg-transparent text-sm text-[#a0a0a0] placeholder:text-[#6a6a6a] outline-none border-none resize-none focus:ring-0 p-0 min-h-[60px] max-h-[200px] overflow-y-auto"
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

            <div className="border-b border-[#2a2a2a]" />

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
                        <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-md bg-transparent border-none hover:bg-white/[0.06] text-[#a0a0a0] gap-1.5 focus:ring-0 shadow-none">
                          <div className="flex items-center gap-1.5">
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor: statusColors[field.value as keyof typeof statusColors],
                              }}
                            />
                            <SelectValue placeholder="Status">
                              {statusLabels[field.value as keyof typeof statusLabels]}
                            </SelectValue>
                          </div>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                        <SelectItem
                          value="todo"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColors.todo }} />
                            Todo
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="in_progress"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColors.in_progress }} />
                            In Progress
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="done"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColors.done }} />
                            Done
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="cancelled"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColors.cancelled }} />
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
                        selectedIds={field.value}
                        onChange={field.onChange}
                        triggerClassName="h-7 w-auto px-2.5 text-xs rounded-md bg-transparent border-none hover:bg-white/[0.06] hover:border-none text-[#a0a0a0] shadow-none"
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
                      <div className="relative">
                        <button
                          type="button"
                          className="h-7 w-auto px-2.5 text-xs rounded-md bg-transparent border-none hover:bg-white/[0.06] text-[#a0a0a0] flex items-center gap-1.5 cursor-pointer"
                          onClick={() => {
                            const input = document.getElementById('dueDate-input') as HTMLInputElement
                            input?.showPicker?.()
                            input?.focus()
                          }}
                        >
                          <CalendarDays className="w-3 h-3 text-[#6a6a6a]" />
                          {field.value ? new Date(field.value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Due date'}
                        </button>
                        <input
                          id="dueDate-input"
                          type="date"
                          className="absolute inset-0 opacity-0 cursor-pointer"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value)}
                        />
                      </div>
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs" />
                  </FormItem>
                )}
              />

              {hasProjects && (
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
                          <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-md bg-transparent border-none hover:bg-white/[0.06] text-[#a0a0a0] gap-1.5 focus:ring-0 shadow-none data-[state=error]:border-red-500">
                            <div className="flex items-center gap-1.5">
                              <FolderKanban className="w-3 h-3 text-[#6a6a6a]" />
                              <SelectValue placeholder="Select project">
                                {field.value
                                  ? projects.find((p) => p.id === field.value)?.name
                                  : "Select project"}
                              </SelectValue>
                            </div>
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                          {projects.map((project) => (
                            <SelectItem
                              key={project.id}
                              value={project.id}
                              className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
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

            <div className="border-b border-[#2a2a2a]" />

            <DialogFooter className="px-4 sm:px-5 py-3 gap-2 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={isSubmitting}
                className="h-8 px-3 text-xs bg-transparent text-[#a0a0a0] hover:bg-white/[0.06] hover:text-[#f5f5f5]"
              >
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[#6a6a6a]">⌘ Enter</span>
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
