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
