/**
 * Minimal CORS middleware. The landing page is served from a different origin
 * (qvac.acurast.dev) than the API (api.qvac.acurast.dev), so browser fetches need
 * permissive CORS. The API is key-protected, so allowing any origin is acceptable;
 * restrict via CORS_ORIGINS if desired.
 */
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";

export function cors(config: Config) {
  const allowAny = config.corsOrigins.includes("*");
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (origin && (allowAny || config.corsOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", allowAny ? "*" : origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key,authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
