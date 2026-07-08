/**
 * Derives per-phase duration estimates (seconds) from replayed history records,
 * so the UI progress bar / ETA reflect what deployments actually take rather than
 * hand-tuned guesses. Falls back to the template's baked-in estimate for any
 * phase without enough observed samples.
 */
import { PHASE_ORDER } from "./types.js";
import type { HistoryRecord, Phase } from "./types.js";

/** Minimum observed samples before a phase's median replaces the fallback. */
const MIN_SAMPLES = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute per-phase estimates for a single template's history records.
 * `records` should already be filtered to one template (any order).
 *
 * For each deployment we take the first timestamp each phase was observed, then
 * attribute the gap between consecutive observed phases to the earlier phase.
 * The per-phase median across deployments becomes the estimate; phases with
 * fewer than MIN_SAMPLES samples keep the template `fallback` value.
 */
export function computeEstimates(
  records: HistoryRecord[],
  fallback: Record<Phase, number>,
): Record<Phase, number> {
  // deployment id -> phase -> earliest epoch ms observed for that phase
  const firstSeen = new Map<string, Map<Phase, number>>();
  for (const r of records) {
    if (!r.phase) continue;
    const ms = Date.parse(r.ts);
    if (Number.isNaN(ms)) continue;
    let byPhase = firstSeen.get(r.id);
    if (!byPhase) {
      byPhase = new Map();
      firstSeen.set(r.id, byPhase);
    }
    const prev = byPhase.get(r.phase);
    if (prev === undefined || ms < prev) byPhase.set(r.phase, ms);
  }

  const samples = new Map<Phase, number[]>();
  for (const byPhase of firstSeen.values()) {
    // Observed phases for this deployment, ordered by the canonical phase order.
    const observed = [...byPhase.entries()].sort(
      (a, b) => PHASE_ORDER.indexOf(a[0]) - PHASE_ORDER.indexOf(b[0]),
    );
    for (let i = 0; i < observed.length - 1; i++) {
      const [phase, ts] = observed[i];
      const nextTs = observed[i + 1][1];
      const seconds = (nextTs - ts) / 1000;
      // Guard against clock skew / out-of-order records producing negatives.
      if (seconds < 0) continue;
      const arr = samples.get(phase);
      if (arr) arr.push(seconds);
      else samples.set(phase, [seconds]);
    }
  }

  const out = {} as Record<Phase, number>;
  for (const phase of PHASE_ORDER) {
    const arr = samples.get(phase);
    out[phase] = arr && arr.length >= MIN_SAMPLES ? Math.round(median(arr)) : fallback[phase];
  }
  return out;
}
