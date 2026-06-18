import { describe, it, expect } from "vitest";
import { EventHub } from "./events";
import type { ProgressEvent } from "./types";

const ev = (id: string): ProgressEvent => ({
  id,
  status: "deploying",
  phase: "matching",
  progress: 0.4,
  etaSeconds: 10,
  tunnelUrl: null,
  error: null,
});

describe("EventHub", () => {
  it("delivers events only to subscribers of that deployment", () => {
    const hub = new EventHub();
    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    hub.subscribe("a", (e) => a.push(e));
    hub.subscribe("b", (e) => b.push(e));
    hub.publish(ev("a"));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("unsubscribe stops delivery and cleans up", () => {
    const hub = new EventHub();
    const off = hub.subscribe("a", () => {});
    expect(hub.subscriberCount("a")).toBe(1);
    off();
    expect(hub.subscriberCount("a")).toBe(0);
    hub.publish(ev("a")); // must not throw
  });

  it("a throwing subscriber does not break others", () => {
    const hub = new EventHub();
    const got: ProgressEvent[] = [];
    hub.subscribe("a", () => {
      throw new Error("boom");
    });
    hub.subscribe("a", (e) => got.push(e));
    hub.publish(ev("a"));
    expect(got).toHaveLength(1);
  });
});
