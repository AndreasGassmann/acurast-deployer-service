/**
 * Append-only JSONL history. The ONLY persistence in the service.
 * One JSON object per line; corrupt lines are skipped on read.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryRecord } from "./types.js";

export class History {
  private readonly filePath: string;
  /** Serializes writes so concurrent appends keep file order. */
  private tail: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "history.jsonl");
  }

  /** Append one record as a single JSON line. Creates the dir/file if needed. */
  append(record: HistoryRecord): Promise<void> {
    const next = this.tail.then(() => this.write(record));
    // keep the chain alive even if a write fails, but surface errors to the caller
    this.tail = next.catch(() => {});
    return next;
  }

  /** Resolves once all queued appends have been flushed. */
  drain(): Promise<void> {
    return this.tail;
  }

  private async write(record: HistoryRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf8");
  }

  /** Read all records in file order. Returns [] if the file does not exist. */
  async readAll(): Promise<HistoryRecord[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, "utf8");
    const out: HistoryRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as HistoryRecord);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  }
}
