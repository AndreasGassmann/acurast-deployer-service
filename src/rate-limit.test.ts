import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows up to max within a window then blocks", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.check("ip", 0)).toBe(true);
    expect(rl.check("ip", 100)).toBe(true);
    expect(rl.check("ip", 200)).toBe(false);
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.check("ip", 0)).toBe(true);
    expect(rl.check("ip", 500)).toBe(false);
    expect(rl.check("ip", 1000)).toBe(true);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("b", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
  });

  it("max<=0 means unlimited", () => {
    const rl = new RateLimiter(0, 1000);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
  });
});
