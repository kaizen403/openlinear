import { Suspense } from "react"
import { OAuthCallbackClient } from "./oauth-callback-client"

export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-linear-bg flex items-center justify-center p-6">
          <div className="w-full max-w-lg rounded-lg border border-linear-border bg-linear-bg-secondary p-6">
            <p className="text-sm text-linear-text-secondary">Loading OAuth callback...</p>
          </div>
        </main>
      }
    >
      <OAuthCallbackClient />
    </Suspense>
  )
}
