/**
 * Turns a raw workload `event=log` message into a single clean, user-facing
 * progress line — or `null` when the line is package-manager / shell noise that
 * should never reach the UI (e.g. the ca-certificates postinst + debconf blob).
 *
 * We surface exactly one latest line at a time, so cleaning is per-line: drop
 * noise, collapse whitespace, and truncate. No raw multi-line output is exposed.
 */

/** Max length of a surfaced line before truncation. */
const MAX_LEN = 120;

/**
 * Substrings that mark a line as noise. Matched case-insensitively anywhere in
 * the message. Covers the debconf/apt/perl chatter the qvac workload emits while
 * installing packages.
 */
const NOISE = [
  "ca-certificates",
  "debconf",
  "unable to initialize frontend",
  "term is not set",
  "falling back to frontend",
  "can't locate",
  "@inc",
  "readline",
  "postinst",
  "dpkg",
  "apt-get",
  "update-ca-certificates",
];

/**
 * Clean a raw log message for display. Returns the cleaned string, or `null` if
 * the line is noise (or empty) and should be dropped.
 */
export function sanitizeLog(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // Collapse all runs of whitespace (incl. embedded newlines) to single spaces.
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;

  const lower = collapsed.toLowerCase();
  if (NOISE.some((n) => lower.includes(n))) return null;

  if (collapsed.length <= MAX_LEN) return collapsed;
  return collapsed.slice(0, MAX_LEN - 1).trimEnd() + "…";
}
