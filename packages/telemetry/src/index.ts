import { setTelemetryHooks, type TelemetryHooks } from "@openlinear/api-core";

interface Counter {
  name: string;
  value: number;
  attributes?: Record<string, string>;
}

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();

function key(name: string, attributes?: Record<string, string>): string {
  if (!attributes) return name;
  return `${name}|${Object.entries(attributes).sort().map(([k, v]) => `${k}=${v}`).join(",")}`;
}

const memoryHooks: TelemetryHooks = {
  count(name, value = 1, attributes) {
    const k = key(name, attributes);
    counters.set(k, (counters.get(k) ?? 0) + value);
  },
  histogram(name, value, attributes) {
    const k = key(name, attributes);
    const series = histograms.get(k) ?? [];
    series.push(value);
    histograms.set(k, series);
  },
  gauge(name, value, attributes) {
    counters.set(key(name, attributes), value);
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

export function snapshotTelemetry(): { counters: Record<string, number>; histograms: Record<string, number> } {
  const histogramMeans: Record<string, number> = {};
  for (const [k, values] of histograms) {
    histogramMeans[k] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return { counters: Object.fromEntries(counters), histograms: histogramMeans };
}

export function recordRoute(method: string, route: string, status: number, durationMs: number): void {
  memoryHooks.count("http.requests", 1, { method, route, status: String(status) });
  memoryHooks.histogram("http.duration_ms", durationMs, { method, route });
}

export type { Counter };
