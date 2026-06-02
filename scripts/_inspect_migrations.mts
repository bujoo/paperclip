import { inspectMigrations, applyPendingMigrations } from "../packages/db/src/client.ts";
const url = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const state = await inspectMigrations(url);
console.log("status:", state.status);
console.log("available count:", state.availableMigrations.length);
console.log("applied count:", (state.appliedMigrations ?? []).length);
const applied = state.appliedMigrations ?? [];
console.log("applied last 6:", applied.slice(-6));
const avail = state.availableMigrations ?? [];
const missing = avail.filter(m => !applied.includes(m));
console.log("missing:", missing);
if (missing.length > 0 && process.argv.includes("--apply")) {
  console.log("Applying...");
  await applyPendingMigrations(url);
  const after = await inspectMigrations(url);
  console.log("After:", after.status, "applied count:", (after.appliedMigrations ?? []).length);
}
