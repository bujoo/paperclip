/**
 * EMQX HTTP Auth backend for the A2A-over-MQTT transport.
 *
 * EMQX calls `POST /api/internal/mqtt-auth` on every MQTT CONNECT. The body
 * (per the EMQX HTTP authenticator spec) contains:
 *
 *   {
 *     "username": "{companyId}/{circleId}/{agentId}" | "host:paperclip-server",
 *     "password": "<HMAC or shared host secret>",
 *     "clientid": "{companyId}/{circleId}/{agentId}",
 *     "peerhost": "1.2.3.4"
 *   }
 *
 * Two auth paths:
 *
 *   1. Host singleton:
 *        username === "host:paperclip-server"
 *      Validates the password against `PAPERCLIP_MQTT_HOST_PASSWORD`.
 *
 *   2. Agent (external A2A clients via the `a2a_mqtt` adapter):
 *        username === "{companyId}/{circleId}/{agentId}"
 *      Looks up the most recent non-revoked `agent_api_keys` row and
 *      verifies the password as
 *        HMAC-SHA256( keyHash + ":" + companyId + ":" + agentId , MQTT_AUTH_SECRET )
 *      base64url-encoded.
 *
 * The HMAC strategy mirrors `server/src/agent-auth-jwt.ts:48-50`, where the
 * server-side JWT signer reuses `PAPERCLIP_AGENT_JWT_SECRET` /
 * `BETTER_AUTH_SECRET`. We honour the same env var fallback so operators
 * don't have to provision a second secret unless they want broker auth keyed
 * separately (in which case set `PAPERCLIP_MQTT_AUTH_SECRET`).
 *
 * Returns the EMQX-shaped response body:
 *   { result: "allow", is_superuser: false }
 *   { result: "deny" }
 *   { result: "ignore" }   (let next authenticator chain try)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys } from "@paperclipai/db";
import { HOST_MQTT_USERNAME } from "./client.js";
import { logger } from "../middleware/logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the secret used to derive per-agent MQTT passwords.
 *
 * Strict-mode policy: in production the dedicated env var
 * `PAPERCLIP_MQTT_AUTH_SECRET` MUST be provisioned. Reusing
 * `BETTER_AUTH_SECRET` broadens the blast radius (a leak of the broker
 * auth secret would also compromise the session/cookie HMAC), so we
 * refuse to fall back in production. In dev we still fall back so
 * `pnpm dev` works without extra setup.
 *
 * The check fires at module load time (via `assertMqttAuthSecretConfigured`)
 * so production deployments fail fast at boot rather than at first connect.
 */
function mqttAuthSecret(): string | null {
  const dedicated = process.env.PAPERCLIP_MQTT_AUTH_SECRET?.trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === "production") {
    // Should be unreachable when `assertMqttAuthSecretConfigured` runs at
    // boot, but defend in depth: never silently fall back in prod.
    return null;
  }
  return (
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    null
  );
}

/**
 * Boot-time assertion: in production, require the dedicated secret. In
 * dev, log a warning if the operator hasn't set the dedicated one so the
 * fallback path is visible.
 */
function assertMqttAuthSecretConfigured(): void {
  if (process.env.PAPERCLIP_MQTT_AUTH_SECRET?.trim()) return;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PAPERCLIP_MQTT_AUTH_SECRET must be set in production (refusing to fall back to BETTER_AUTH_SECRET to limit blast radius)",
    );
  }
  logger.warn(
    "mqtt-auth: PAPERCLIP_MQTT_AUTH_SECRET not set — falling back to PAPERCLIP_AGENT_JWT_SECRET / BETTER_AUTH_SECRET in dev mode",
  );
}

assertMqttAuthSecretConfigured();

/** Resolve the shared secret used by the host singleton's own connection. */
function mqttHostSecret(): string | null {
  return process.env.PAPERCLIP_MQTT_HOST_PASSWORD?.trim() || null;
}

interface MqttAuthRequestBody {
  username?: unknown;
  password?: unknown;
  clientid?: unknown;
  peerhost?: unknown;
}

/**
 * Compute the canonical password expected for a given agent identity.
 * Exported for test harnesses + the `a2a_mqtt` adapter so external A2A
 * agents managed by Paperclip can derive the credential the same way.
 */
export function computeAgentMqttPassword(args: {
  keyHash: string;
  companyId: string;
  agentId: string;
  secret: string;
}): string {
  const message = `${args.keyHash}:${args.companyId}:${args.agentId}`;
  return createHmac("sha256", args.secret).update(message).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Build the router that exposes `POST /api/internal/mqtt-auth`. Mounted
 * by `app.ts` under the `/api` prefix.
 */
export function mqttAuthRoutes(db: Db) {
  const router = Router();

  router.post("/internal/mqtt-auth", async (req: Request, res: Response) => {
    const body = req.body as MqttAuthRequestBody;
    const usernameRaw = typeof body.username === "string" ? body.username : "";
    const passwordRaw = typeof body.password === "string" ? body.password : "";

    // --- Host singleton path ------------------------------------------------
    if (usernameRaw === HOST_MQTT_USERNAME) {
      const expected = mqttHostSecret();
      if (!expected) {
        // No shared host secret configured — allow only when the host AND
        // the broker both run in dev mode with auth disabled. To avoid
        // silently allowing anonymous host connections in production, deny
        // unless the operator explicitly opted in via
        // `PAPERCLIP_MQTT_ALLOW_ANONYMOUS_HOST=true`.
        if (process.env.PAPERCLIP_MQTT_ALLOW_ANONYMOUS_HOST === "true") {
          res.status(200).json({ result: "allow", is_superuser: true });
          return;
        }
        logger.warn(
          "mqtt-auth: host singleton denied — set PAPERCLIP_MQTT_HOST_PASSWORD or PAPERCLIP_MQTT_ALLOW_ANONYMOUS_HOST=true",
        );
        res.status(200).json({ result: "deny" });
        return;
      }
      if (constantTimeEquals(passwordRaw, expected)) {
        res.status(200).json({ result: "allow", is_superuser: true });
      } else {
        res.status(200).json({ result: "deny" });
      }
      return;
    }

    // --- Per-agent path -----------------------------------------------------
    // Parse "{companyId}/{circleId}/{agentId}".
    const parts = usernameRaw.split("/");
    if (parts.length !== 3) {
      res.status(200).json({ result: "deny" });
      return;
    }
    const [companyId, circleId, agentId] = parts as [string, string, string];
    if (!UUID_RE.test(companyId) || !UUID_RE.test(circleId) || !UUID_RE.test(agentId)) {
      res.status(200).json({ result: "deny" });
      return;
    }

    const secret = mqttAuthSecret();
    if (!secret) {
      logger.warn(
        "mqtt-auth: cannot validate agent connect — set PAPERCLIP_MQTT_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET, or BETTER_AUTH_SECRET",
      );
      res.status(200).json({ result: "deny" });
      return;
    }

    try {
      const rows = await db
        .select({ id: agentApiKeys.id, keyHash: agentApiKeys.keyHash })
        .from(agentApiKeys)
        .where(
          and(
            eq(agentApiKeys.agentId, agentId),
            eq(agentApiKeys.companyId, companyId),
            isNull(agentApiKeys.revokedAt),
          ),
        )
        .orderBy(desc(agentApiKeys.createdAt))
        .limit(1);

      if (rows.length === 0) {
        res.status(200).json({ result: "deny" });
        return;
      }

      const expected = computeAgentMqttPassword({
        keyHash: rows[0]!.keyHash,
        companyId,
        agentId,
        secret,
      });

      if (constantTimeEquals(passwordRaw, expected)) {
        res.status(200).json({ result: "allow", is_superuser: false });
      } else {
        res.status(200).json({ result: "deny" });
      }
    } catch (err) {
      logger.warn({ err, agentId }, "mqtt-auth: db lookup failed");
      res.status(200).json({ result: "deny" });
    }
  });

  return router;
}
