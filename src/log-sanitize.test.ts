import { describe, it, expect } from "vitest";
import { sanitizeLog } from "./log-sanitize";

describe("sanitizeLog", () => {
  it("keeps a friendly line unchanged", () => {
    expect(sanitizeLog("Installing Node.js v24.16.0")).toBe("Installing Node.js v24.16.0");
  });

  it("collapses whitespace and newlines", () => {
    expect(sanitizeLog("Loading   the\n\tmodel  ")).toBe("Loading the model");
  });

  it("drops the ca-certificates / debconf noise blob", () => {
    const noise =
      "ca-certificates postinst failed, building CA bundle manually: Setting up ca-certificates ... debconf: unable to initialize frontend: Dialog";
    expect(sanitizeLog(noise)).toBeNull();
  });

  it("drops perl @INC / Can't locate chatter", () => {
    expect(sanitizeLog("Can't locate Term/ReadLine.pm in @INC (you may need ...)")).toBeNull();
  });

  it("drops empty / whitespace-only lines", () => {
    expect(sanitizeLog("   ")).toBeNull();
    expect(sanitizeLog("")).toBeNull();
  });

  it("truncates over-long lines with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = sanitizeLog(long)!;
    expect(out.length).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });
});
