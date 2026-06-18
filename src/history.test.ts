import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History } from "./history";
import type { HistoryRecord } from "./types";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (id: string, event: string): HistoryRecord => ({
  ts: "2026-06-18T00:00:00.000Z",
  id,
  template: "qvac",
  event,
  phase: null,
  status: "created",
  public: false,
});

describe("History", () => {
  it("returns [] when the file does not exist", async () => {
    const h = new History(dir);
    expect(await h.readAll()).toEqual([]);
  });

  it("appends and reads back records in order", async () => {
    const h = new History(dir);
    await h.append(rec("a", "created"));
    await h.append(rec("b", "created"));
    const all = await h.readAll();
    expect(all.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("skips corrupt lines", async () => {
    const h = new History(dir);
    await h.append(rec("a", "created"));
    // append raw garbage
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "history.jsonl"), "not json\n", "utf8");
    await h.append(rec("b", "created"));
    const all = await h.readAll();
    expect(all.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
