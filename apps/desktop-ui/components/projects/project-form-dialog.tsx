"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { RepoPickerField } from "@/components/shared/repo-picker-field"
import {
  mapErrorToForm,
  statusOptions,
  type StatusType,
  type ProjectFormData,
  emptyFormData,
  projectToFormData,
} from "@/hooks/use-projects"
import type { Project } from "@/lib/api"

interface ProjectFormDialogProps {
  mode: "create" | "edit"
  open: boolean
  onOpenChange: (open: boolean) => void
  project?: Project | null
  isDesktopApp: boolean
  onSubmit: (formData: ProjectFormData) => Promise<void>
}

export function ProjectFormDialog({
  mode,
  open,
  onOpenChange,
  project,
  isDesktopApp,
  onSubmit,
}: ProjectFormDialogProps) {
  const [formData, setFormData] = useState<ProjectFormData>(
    mode === "edit" && project ? projectToFormData(project) : emptyFormData
  )
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setFormErrors({})
      if (mode === "edit" && project) {
        setFormData(projectToFormData(project))
      } else {
        setFormData(emptyFormData)
      }
    }
    onOpenChange(nextOpen)
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}
    if (!formData.name.trim()) {
      errors.name = "Name is required"
    }
    if (formData.sourceType === "local" && isDesktopApp && !formData.localPath.trim()) {
      errors.localPath = "Choose a local folder"
    }
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm()) return

    setIsSubmitting(true)
    try {
      await onSubmit(formData)
      if (mode === "create") setFormData(emptyFormData)
      onOpenChange(false)
    } catch (error) {
      const { toastMessage, formErrors: nextErrors } = mapErrorToForm(
        error,
        "Could not reach OpenLinear server. Check your connection and try again.",
      )
      setFormErrors((prev) => ({ ...prev, ...nextErrors }))
      toast.error(toastMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const isCreate = mode === "create"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px] bg-linear-bg border-linear-border">
        <DialogHeader>
          <DialogTitle className="text-linear-text">
            {isCreate ? "Create Project" : "Edit Project"}
          </DialogTitle>
          <DialogDescription className="text-linear-text-secondary">
            {isCreate
              ? "Create a new project to organize your tasks."
              : "Update the project details."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor={`${mode}-name`} className="text-linear-text">
              Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id={`${mode}-name`}
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Project name"
              className={cn(
                "bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary",
                formErrors.name && "border-red-500"
              )}
            />
            {formErrors.name && (
              <p className="text-xs text-red-500">{formErrors.name}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${mode}-description`} className="text-linear-text">Description</Label>
            <Input
              id={`${mode}-description`}
              value={formData.description}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Project description (optional)"
              className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${mode}-status`} className="text-linear-text">Status</Label>
            <Select
              value={formData.status}
              onValueChange={(value) => setFormData(prev => ({ ...prev, status: value as StatusType }))}
            >
              <SelectTrigger className="bg-linear-bg-tertiary border-linear-border text-linear-text">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg border-linear-border">
                {statusOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text"
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${mode}-targetDate`} className="text-linear-text">Target Date</Label>
            <DatePicker
              value={formData.targetDate}
              onChange={(val) => setFormData(prev => ({ ...prev, targetDate: val }))}
              placeholder="Select target date"
              className="h-8 px-3 text-sm w-full justify-start bg-linear-bg-tertiary border border-linear-border"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-linear-text">Source</Label>
            <RepoPickerField
              formData={formData}
              setFormData={setFormData}
              isDesktopApp={isDesktopApp}
              namePrefix={mode === "edit" ? "edit-" : ""}
            />
            {formErrors.localPath && (
              <p className="text-xs text-red-500">{formErrors.localPath}</p>
            )}
          </div>

          {formErrors._root && (
            <div role="alert" className="rounded-sm border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {formErrors._root}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-linear-accent hover:bg-linear-accent-hover text-white"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {isCreate ? "Creating..." : "Saving..."}
                </>
              ) : (
                isCreate ? "Create Project" : "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
