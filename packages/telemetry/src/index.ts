import { setTelemetryHooks, type TelemetryHooks } from "@openlinear/api-core";
import { BoundedHistogram, type HistogramSummary } from "./histogram";

interface Counter {
  name: string;
  value: number;
  attributes?: Record<string, string>;
}

/**
 * In-process series are bounded twice: each histogram is fixed-size (see
 * histogram.ts) instead of keeping every sample, and the number of distinct
 * series (name + attributes) is capped so a high-cardinality attribute cannot
 * grow memory without bound. Values past the cap are folded into one
 * `<name>|overflow=true` series per metric name.
 */
export const MAX_SERIES = 1024;

const counters = new Map<string, number>();
const histograms = new Map<string, BoundedHistogram>();

function key(name: string, attributes?: Record<string, string>): string {
  if (!attributes) return name;
  return `${name}|${Object.entries(attributes).sort().map(([k, v]) => `${k}=${v}`).join(",")}`;
}

function boundedKey(series: ReadonlyMap<string, unknown>, name: string, attributes?: Record<string, string>): string {
  const k = key(name, attributes);
  if (series.has(k) || series.size < MAX_SERIES) return k;
  return `${name}|overflow=true`;
}

const memoryHooks: TelemetryHooks = {
  count(name, value = 1, attributes) {
    const k = boundedKey(counters, name, attributes);
    counters.set(k, (counters.get(k) ?? 0) + value);
  },
  histogram(name, value, attributes) {
    const k = boundedKey(histograms, name, attributes);
    let series = histograms.get(k);
    if (!series) {
      series = new BoundedHistogram();
      histograms.set(k, series);
    }
    series.record(value);
  },
  gauge(name, value, attributes) {
    counters.set(boundedKey(counters, name, attributes), value);
  },
};

/**
 * In-process RED metrics. Swap `setTelemetryHooks` for OTel exporters when
 * an OTLP endpoint is configured (`OTEL_EXPORTER_OTLP_ENDPOINT`).
 */
export function startTelemetry(): TelemetryHooks {
  setTelemetryHooks(memoryHooks);
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // OTLP wiring is additive; the in-process hooks still feed /readyz gauges.
  }
  return memoryHooks;
}

export interface TelemetrySnapshot {
  counters: Record<string, number>;
  /** Mean per histogram series (unchanged contract). */
  histograms: Record<string, number>;
  /** count/sum/mean/min/max and p50/p95/p99 per histogram series. */
  histogramSummaries: Record<string, HistogramSummary>;
}

export function snapshotTelemetry(): TelemetrySnapshot {
  const histogramMeans: Record<string, number> = {};
  const histogramSummaries: Record<string, HistogramSummary> = {};
  for (const [k, series] of histograms) {
    const summary = series.summary();
    histogramMeans[k] = summary.mean;
    histogramSummaries[k] = summary;
  }
  return { counters: Object.fromEntries(counters), histograms: histogramMeans, histogramSummaries };
}

/** Test seam: drop every in-process series. */
export function resetTelemetry(): void {
  counters.clear();
  histograms.clear();
}

export function recordRoute(method: string, route: string, status: number, durationMs: number): void {
  memoryHooks.count("http.requests", 1, { method, route, status: String(status) });
  memoryHooks.histogram("http.duration_ms", durationMs, { method, route });
}

export { BoundedHistogram } from "./histogram";
export type { HistogramSummary } from "./histogram";
export type { Counter };
