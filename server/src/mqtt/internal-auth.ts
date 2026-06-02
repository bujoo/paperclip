/**
 * Shared-secret guard for the EMQX-facing internal endpoints
 * (`/api/internal/mqtt-auth`, `/api/internal/mqtt-acl`).
 *
 * Without this guard, anyone who can reach the API can probe the auth
 * callback to brute-force credentials or enumerate ACL policy. The broker
 * is the only legitimate caller, so we authenticate every request with a
 * shared secret in the `X-Paperclip-Mqtt-Internal-Secret` header.
 *
 * Policy:
 *   - If `PAPERCLIP_MQTT_INTERNAL_SECRET` is set, require it on every
 *     request; reject (403) otherwise.
 *   - If unset in production (`NODE_ENV=production`), fail closed — reject
 *     ALL requests so operators must explicitly provision the secret.
 *   - If unset in dev, log a warning once and allow through, so local
 *     `pnpm dev` keeps working without extra setup.
 *
 * Production deployments should ALSO restrict these routes at the proxy
 * layer to the broker's source IP; this header is defense-in-depth, not a
 * replacement for network isolation.
 */
import type { Request, RequestHandler, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../middleware/logger.js";

const HEADER_NAME = "x-paperclip-mqtt-internal-secret";
let _devWarningLogged = false;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function requireMqttInternalAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.PAPERCLIP_MQTT_INTERNAL_SECRET?.trim();
    const provided =
      typeof req.headers[HEADER_NAME] === "string"
        ? (req.headers[HEADER_NAME] as string).trim()
        : "";

    if (!expected) {
      if (process.env.NODE_ENV === "production") {
        // Fail closed in production — the operator must provision the
        // secret deliberately rather than silently running an open auth
        // callback exposed to anyone who can reach the API.
        logger.warn(
          "mqtt-internal-auth: PAPERCLIP_MQTT_INTERNAL_SECRET unset in production — denying",
        );
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!_devWarningLogged) {
        _devWarningLogged = true;
        logger.warn(
          "mqtt-internal-auth: PAPERCLIP_MQTT_INTERNAL_SECRET unset — allowing in dev mode. Set the env var to enable the header check.",
        );
      }
      next();
      return;
    }

    if (provided && constantTimeEquals(provided, expected)) {
      next();
      return;
    }
    res.status(403).json({ error: "Forbidden" });
  };
}
