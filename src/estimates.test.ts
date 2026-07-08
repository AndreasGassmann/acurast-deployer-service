import { describe, it, expect } from "vitest";
import { computeEstimates } from "./estimates";
import type { HistoryRecord, Phase } from "./types";

const fallback: Record<Phase, number> = {
  uploaded: 1,
  prepared: 2,
  submitted: 3,
  matching: 4,
  matched: 5,
  ack: 6,
  "env-set": 7,
  started: 8,
  "model-loading": 9,
  "model-ready": 0,
};

/** Build a phase record at a given epoch-second for a deployment. */
function rec(id: string, phase: Phase, epochSec: number): HistoryRecord {
  return {
    ts: new Date(epochSec * 1000).toISOString(),
    id,
    template: "qvac",
    event: `phase:${phase}`,
    phase,
    status: "deploying",
    public: true,
  };
}

describe("computeEstimates", () => {
  it("uses the fallback for phases without enough samples", () => {
    const out = computeEstimates([], fallback);
    expect(out).toEqual(fallback);
  });

  it("uses the median of observed per-phase durations once MIN_SAMPLES is met", () => {
    // 3 deployments each spending 10/20/30s in `matching` -> median 20s.
    const records: HistoryRecord[] = [];
    const durations = [10, 20, 30];
    durations.forEach((d, i) => {
      const id = `dep${i}`;
      records.push(rec(id, "matching", 0));
      records.push(rec(id, "matched", d)); // gap attributed to `matching`
    });
    const out = computeEstimates(records, fallback);
    expect(out.matching).toBe(20);
    // matched has no successor observed -> falls back
    expect(out.matched).toBe(fallback.matched);
  });

  it("falls back when a phase has fewer than 3 samples", () => {
    const records = [rec("a", "matching", 0), rec("a", "matched", 100)];
    const out = computeEstimates(records, fallback);
    expect(out.matching).toBe(fallback.matching);
  });

  it("ignores negative gaps from out-of-order records", () => {
    const records: HistoryRecord[] = [];
    // 3 clean samples of 10s plus one deployment with reversed timestamps.
    for (let i = 0; i < 3; i++) {
      records.push(rec(`c${i}`, "started", 0), rec(`c${i}`, "model-loading", 10));
    }
    const out = computeEstimates(records, fallback);
    expect(out.started).toBe(10);
  });
});
