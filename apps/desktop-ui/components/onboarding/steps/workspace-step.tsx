"use client"

import { useReducedMotion } from "framer-motion"
import { motion } from "framer-motion"
import { ArrowRight, Building2, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { SPRING } from "./onboarding-utils"

export function WorkspaceStep({
  workspaceName,
  isCreating,
  onChange,
  onCreate,
}: {
  workspaceName: string
  isCreating: boolean
  onChange: (name: string) => void
  onCreate: () => void
}) {
  const reduceMotion = useReducedMotion()

  return (
    <div className="text-center space-y-5">
      <motion.div
        initial={reduceMotion ? false : { scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.1 }}
        className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center"
      >
        <Building2 className="w-6 h-6 text-linear-accent" />
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.2 }}
        className="space-y-2"
      >
        <h2 className="text-xl font-semibold text-linear-text">Create your workspace</h2>
        <p className="text-sm text-linear-text-secondary max-w-sm mx-auto leading-relaxed">
          A workspace is your team&apos;s home. All projects and members live here.
        </p>
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.3 }}
        className="max-w-xs mx-auto space-y-4"
      >
        <Input
          placeholder="e.g. Acme Inc"
          value={workspaceName}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && workspaceName.trim()) onCreate()
          }}
          className="text-center h-9"
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={!workspaceName.trim() || isCreating}
          className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-9 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              Continue
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </motion.div>
    </div>
  )
}
