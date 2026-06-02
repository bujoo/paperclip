import pgModule from "/Users/tom/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js";
const { Pool } = pgModule;
import { pathToFileURL } from "node:url";

const pluginName = process.argv[2] ?? "@paperclipai/plugin-holacracy";
const manifestFile = `/Users/tom/paperclip/packages/plugins/${pluginName.replace("@paperclipai/", "")}/dist/manifest.js`;

const mod = await import(pathToFileURL(manifestFile).href);
const manifest = mod.default ?? mod.manifest;
if (!manifest) {
  console.error("manifest export not found in", manifestFile);
  process.exit(1);
}

const pool = new Pool({
  host: "127.0.0.1",
  port: 54329,
  user: "paperclip",
  database: "paperclip",
  password: "paperclip",
});

const client = await pool.connect();
try {
  const { rowCount } = await client.query(
    `UPDATE plugins SET manifest_json = $1::jsonb, updated_at = now() WHERE package_name = $2`,
    [JSON.stringify(manifest), pluginName],
  );
  console.log(`Updated ${rowCount} plugin row(s) for ${pluginName}`);
} finally {
  client.release();
  await pool.end();
}
