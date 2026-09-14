"use client"

import { useState, useMemo } from "react"
import { Check, UserCircle, UserPlus } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"

export interface AssigneeMember {
  id: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
}

interface AssigneePickerProps {
  value: string[]
  onChange: (ids: string[]) => void
  members: AssigneeMember[]
  currentUserId?: string
  placeholder?: string
  className?: string
}

function MemberAvatar({ member, size = 18 }: { member: AssigneeMember; size?: number }) {
  if (member.avatarUrl) {
    return (
      <img
        src={member.avatarUrl}
        alt={member.displayName || member.username}
        className="rounded-full"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className="rounded-full bg-linear-bg-tertiary flex items-center justify-center text-linear-text-tertiary"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {(member.displayName || member.username).charAt(0).toUpperCase()}
    </div>
  )
}

export function AssigneePicker({
  value,
  onChange,
  members,
  currentUserId,
  placeholder = "Assignee",
  className,
}: AssigneePickerProps) {
  const [open, setOpen] = useState(false)

  const selectedMembers = useMemo(
    () => members.filter((m) => value.includes(m.id)),
    [members, value]
  )

  const toggle = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id))
    } else {
      onChange([...value, id])
    }
  }

  const assignToMe = () => {
    if (currentUserId && !value.includes(currentUserId)) {
      onChange([...value, currentUserId])
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-7 inline-flex items-center gap-1.5 px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary text-linear-text-secondary cursor-pointer outline-none",
            className
          )}
        >
          {selectedMembers.length === 0 ? (
            <>
              <UserCircle className="w-3 h-3 text-linear-text-tertiary" />
              <span>{placeholder}</span>
            </>
          ) : (
            <>
              <div className="flex -space-x-1">
                {selectedMembers.slice(0, 3).map((m) => (
                  <MemberAvatar key={m.id} member={m} size={16} />
                ))}
              </div>
              {selectedMembers.length > 3 && (
                <span className="text-linear-text-tertiary">+{selectedMembers.length - 3}</span>
              )}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-0 bg-linear-bg-secondary border-linear-border"
        align="start"
      >
        <Command className="bg-transparent">
          <CommandInput
            placeholder="Search members..."
            className="h-8 text-xs text-linear-text placeholder:text-linear-text-tertiary"
          />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-linear-text-tertiary">
              No members found.
            </CommandEmpty>
            {currentUserId && (
              <>
                <CommandGroup>
                  <CommandItem
                    onSelect={assignToMe}
                    className="text-xs text-linear-text cursor-pointer data-[selected=true]:bg-linear-bg-tertiary"
                  >
                    <UserPlus className="mr-2 h-3.5 w-3.5 text-linear-text-tertiary" />
                    Assign to me
                    {value.includes(currentUserId) && (
                      <Check className="ml-auto h-3.5 w-3.5 text-linear-accent" />
                    )}
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator className="bg-linear-border" />
              </>
            )}
            <CommandGroup>
              {members.map((member) => (
                <CommandItem
                  key={member.id}
                  value={`${member.username} ${member.displayName || ""}`}
                  onSelect={() => toggle(member.id)}
                  className="text-xs text-linear-text cursor-pointer data-[selected=true]:bg-linear-bg-tertiary"
                >
                  <MemberAvatar member={member} size={18} />
                  <span className="ml-2 truncate">
                    {member.displayName || member.username}
                  </span>
                  {value.includes(member.id) && (
                    <Check className="ml-auto h-3.5 w-3.5 text-linear-accent" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
