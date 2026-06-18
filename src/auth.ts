/**
 * API-key authentication. Two key kinds:
 *  - "full":   any key in config.apiKeys. May deploy any template + read history.
 *  - "public": the single config.publicDeployKey. May ONLY deploy template "qvac",
 *              rate-limited per IP. Safe to expose in the static landing page.
 */
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";

export type AuthKind = "full" | "public";

export interface AuthInfo {
  kind: AuthKind;
  key: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

function readKey(req: Request): string | undefined {
  const header = req.header("x-api-key");
  if (header && header.trim()) return header.trim();
  // also accept Authorization: Bearer <key>
  const auth = req.header("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

/** Resolve the key (if any) into req.auth. Does NOT reject; routes enforce. */
export function identify(config: Config) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = readKey(req);
    if (key) {
      if (config.apiKeys.includes(key)) req.auth = { kind: "full", key };
      else if (key === config.publicDeployKey) req.auth = { kind: "public", key };
    }
    next();
  };
}

/** Reject with 401 unless a valid key (full or public) was supplied. */
export function requireKey(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "missing or invalid API key" });
    return;
  }
  next();
}

/** Reject with 401 unless a FULL key was supplied. */
export function requireFullKey(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.kind !== "full") {
    res.status(401).json({ error: "full API key required" });
    return;
  }
  next();
}
