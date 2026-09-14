import { Suspense } from "react"
import { SessionCallbackClient } from "./session-callback-client"

export default function AuthSessionPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-linear-bg flex items-center justify-center p-6">
          <div className="w-full max-w-md rounded-sm border border-linear-border bg-linear-bg-secondary p-6">
            <img src="/brand/logo.png" alt="OpenLinear" className="h-10 mx-auto mb-4" />
            <p className="text-sm text-linear-text-secondary text-center">Signing you in...</p>
          </div>
        </main>
      }
    >
      <SessionCallbackClient />
    </Suspense>
  )
}
