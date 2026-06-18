/**
 * In-process SSE hub. Per-deployment fan-out of progress events to any number
 * of subscribers. No external broker — single-process only (matches our design).
 */
import type { ProgressEvent } from "./types.js";

type Listener = (event: ProgressEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  /** Subscribe to events for one deployment. Returns an unsubscribe function. */
  subscribe(deploymentId: string, listener: Listener): () => void {
    let set = this.listeners.get(deploymentId);
    if (!set) {
      set = new Set();
      this.listeners.set(deploymentId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(deploymentId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(deploymentId);
    };
  }

  /** Push an event to all subscribers of its deployment. */
  publish(event: ProgressEvent): void {
    const set = this.listeners.get(event.id);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the others
      }
    }
  }

  /** Number of active subscribers for a deployment (testing/introspection). */
  subscriberCount(deploymentId: string): number {
    return this.listeners.get(deploymentId)?.size ?? 0;
  }
}
