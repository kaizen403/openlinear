"use client"

import { Check } from "lucide-react"
import { STEP_LABELS } from "./onboarding-utils"

export function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="mb-5">
      <div className="flex items-center">
        {STEP_LABELS.map((label, index) => {
          const isActive = index === currentStep
          const isCompleted = index < currentStep

          return (
            <div key={label} className="contents">
              <div className="flex flex-col items-center shrink-0">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors duration-300 ${
                    isCompleted || isActive
                      ? "bg-linear-accent text-white"
                      : "bg-linear-bg border-2 border-linear-border text-linear-text-tertiary"
                  }`}
                >
                  {isCompleted ? <Check className="w-3.5 h-3.5" /> : <span>{index + 1}</span>}
                </div>
                <span
                  className={`mt-1.5 text-xs text-center whitespace-nowrap ${
                    isActive
                      ? "text-linear-text font-medium"
                      : isCompleted
                        ? "text-linear-text-secondary"
                        : "text-linear-text-tertiary"
                  }`}
                >
                  {label}
                </span>
              </div>
              {index < STEP_LABELS.length - 1 && (
                <div className="flex-1 h-[2px] mx-3 mb-4 transition-colors duration-500">
                  <div
                    className={`h-full rounded-full transition-colors duration-500 ${
                      index < currentStep ? "bg-linear-accent" : "bg-linear-border"
                    }`}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
