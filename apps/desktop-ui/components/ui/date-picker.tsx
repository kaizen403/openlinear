"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

function formatDisplay(date: string): string {
  const d = new Date(date)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date())
}

interface DatePickerProps {
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function DatePicker({ value, onChange, placeholder = "Due date", className }: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [viewDate, setViewDate] = React.useState(() => {
    if (value) return new Date(value)
    return new Date()
  })

  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)

  const selectedDate = value ? new Date(value) : null

  function prevMonth() {
    setViewDate(new Date(year, month - 1, 1))
  }

  function nextMonth() {
    setViewDate(new Date(year, month + 1, 1))
  }

  function selectDate(day: number) {
    const date = new Date(year, month, day)
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, "0")
    const dd = String(date.getDate()).padStart(2, "0")
    onChange(`${yyyy}-${mm}-${dd}`)
    setOpen(false)
  }

  function clearDate() {
    onChange("")
    setOpen(false)
  }

  // Build grid cells
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-7 w-auto px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary text-linear-text-secondary flex items-center gap-1.5 cursor-pointer transition-colors",
            value && "text-linear-text",
            className
          )}
        >
          <CalendarDays className="w-3 h-3 text-linear-text-tertiary" />
          {value ? formatDisplay(value) : placeholder}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={prevMonth}
            className="h-6 w-6 flex items-center justify-center rounded-sm hover:bg-linear-bg-tertiary text-linear-text-secondary cursor-pointer transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-medium text-linear-text">
            {MONTHS[month]} {year}
          </span>
          <button
            type="button"
            onClick={nextMonth}
            className="h-6 w-6 flex items-center justify-center rounded-sm hover:bg-linear-bg-tertiary text-linear-text-secondary cursor-pointer transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {DAYS.map((day) => (
            <div key={day} className="h-6 flex items-center justify-center text-[10px] font-medium text-linear-text-tertiary">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            if (day === null) {
              return <div key={`empty-${i}`} className="h-7 w-full" />
            }

            const cellDate = new Date(year, month, day)
            const isSelected = selectedDate && isSameDay(cellDate, selectedDate)
            const isTodayDate = isToday(cellDate)

            return (
              <button
                key={day}
                type="button"
                onClick={() => selectDate(day)}
                className={cn(
                  "h-7 w-full flex items-center justify-center text-xs rounded-sm cursor-pointer transition-colors",
                  "text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text",
                  isSelected && "bg-accent text-accent-foreground hover:bg-accent",
                  isTodayDate && !isSelected && "text-linear-text font-medium"
                )}
              >
                {day}
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
          <button
            type="button"
            onClick={() => selectDate(new Date().getDate())}
            className="text-[10px] text-linear-text-tertiary hover:text-linear-text cursor-pointer transition-colors"
          >
            Today
          </button>
          {value && (
            <button
              type="button"
              onClick={clearDate}
              className="text-[10px] text-linear-text-tertiary hover:text-red-400 cursor-pointer transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
