"use client"

import { useReportWebVitals } from "next/web-vitals"

/**
 * Web vitals (performance plan, Phase 0): LCP, INP, CLS, FCP and TTFB.
 *
 * Logged to the browser console in development, or in any build when
 * `localStorage["openlinear-web-vitals"] === "1"`. Nothing is sent over the
 * network yet; a reporting endpoint is a follow-up. UUIDs in the route are
 * masked so pasted logs do not carry task or project ids.
 */

const REPORTED = new Set(["LCP", "INP", "CLS", "FCP", "TTFB"])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function enabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true
  try {
    return window.localStorage.getItem("openlinear-web-vitals") === "1"
  } catch {
    return false
  }
}

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (!REPORTED.has(metric.name) || !enabled()) return
    console.info("[web-vitals]", {
      name: metric.name,
      value: metric.name === "CLS" ? Number(metric.value.toFixed(4)) : Math.round(metric.value),
      rating: metric.rating,
      navigationType: metric.navigationType,
      route: window.location.pathname.replace(UUID, ":id"),
      id: metric.id,
    })
  })
  return null
}
