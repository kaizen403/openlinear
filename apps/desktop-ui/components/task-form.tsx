"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
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

const formSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]),
  labelIds: z.array(z.string()),
})

type FormValues = z.infer<typeof formSchema>

interface TaskFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

const API_BASE_URL = "http://localhost:3001/api"

const priorityColors = {
  low: "bg-blue-400",
  medium: "bg-yellow-400",
  high: "bg-red-400",
}

const priorityLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
}

export function TaskFormDialog({
  open,
  onOpenChange,
  onSuccess,
}: TaskFormDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      description: "",
      priority: "medium",
      labelIds: [],
    },
  })

  const onSubmit = async (values: FormValues) => {
    try {
      setIsSubmitting(true)

      const response = await fetch(`${API_BASE_URL}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: values.title,
          description: values.description || undefined,
          priority: values.priority,
          labelIds: values.labelIds.length > 0 ? values.labelIds : undefined,
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px] bg-[#1a1a1a] border-[#2a2a2a] p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Create Task</DialogTitle>
        <DialogDescription className="sr-only">
          Create a new task with title, description, priority, and labels
        </DialogDescription>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col">
            <div className="px-5 pt-4 pb-3">
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
                        className="w-full bg-transparent text-sm text-[#a0a0a0] placeholder:text-[#6a6a6a] outline-none border-none resize-none focus:ring-0 p-0 min-h-[24px]"
                        rows={1}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-red-400 text-xs mt-1" />
                  </FormItem>
                )}
              />
            </div>

            <div className="border-b border-[#2a2a2a]" />

            <div className="px-5 py-3 flex items-center gap-2">
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem className="space-y-0">
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-md bg-transparent border-none hover:bg-white/[0.06] text-[#a0a0a0] gap-1.5 focus:ring-0 shadow-none">
                          <div className="flex items-center gap-1.5">
                            <div
                              className={`w-2 h-2 rounded-full ${
                                priorityColors[field.value as keyof typeof priorityColors]
                              }`}
                            />
                            <SelectValue placeholder="Priority">
                              {priorityLabels[field.value as keyof typeof priorityLabels]}
                            </SelectValue>
                          </div>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                        <SelectItem
                          value="low"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-blue-400" />
                            Low
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="medium"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-yellow-400" />
                            Medium
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="high"
                          className="text-[#f5f5f5] focus:bg-white/[0.06] focus:text-[#f5f5f5] text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-red-400" />
                            High
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
            </div>

            <div className="border-b border-[#2a2a2a]" />

            <DialogFooter className="px-5 py-3 gap-2 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={isSubmitting}
                className="h-8 px-3 text-xs bg-transparent text-[#a0a0a0] hover:bg-white/[0.06] hover:text-[#f5f5f5]"
              >
                Cancel
              </Button>
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
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
