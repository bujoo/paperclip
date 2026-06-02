import type { Logger } from "pino";

/**
 * Normalize the result of `db.execute(...)` into a plain array.
 *
 * Drizzle's node-postgres driver returns the raw `pg.QueryResult` shape
 * (`{ rows: T[] }`) while neon/HTTP drivers return `T[]` directly. Call sites
 * that don't care about the difference can route every execute() through here.
 */
export function coerceRowsList<T>(rows: unknown): T[] {
  if (Array.isArray(rows)) return rows as T[];
  if (rows && typeof rows === "object" && Array.isArray((rows as { rows?: unknown }).rows)) {
    return (rows as { rows: T[] }).rows;
  }
  return [];
}

interface SafeLoadOptions {
  logger?: Logger;
  message?: string;
  context?: Record<string, unknown>;
}

/**
 * Run a best-effort loader: returns the loader's value, or `defaultValue` if
 * the loader throws. Used for queries against optional plugin schemas where
 * absence is the common case (e.g. `plugin_holacracy_c5049b5dfe.*` before the
 * plugin is installed) and a failure should not surface to the caller.
 *
 * Pass `opts.logger` + `opts.message` to emit a debug line on failure;
 * otherwise the error is swallowed silently.
 */
export async function safeLoad<T>(
  loader: () => Promise<T>,
  defaultValue: T,
  opts?: SafeLoadOptions,
): Promise<T> {
  try {
    return await loader();
  } catch (err) {
    if (opts?.logger && opts.message) {
      opts.logger.debug({ ...(opts.context ?? {}), err }, opts.message);
    }
    return defaultValue;
  }
}
