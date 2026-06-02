import pgModule from "/Users/tom/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js";
const { Pool } = pgModule;
import { createHash, randomBytes } from "node:crypto";

const pool = new Pool({
  host: "127.0.0.1",
  port: 54329,
  user: "paperclip",
  database: "paperclip",
  password: "paperclip",
});

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

const client = await pool.connect();
try {
  const { rows: agentsNeedingKeys } = await client.query(`
    SELECT a.id, a.company_id, a.name
    FROM agents a
    WHERE a.status NOT IN ('terminated', 'pending_approval')
      AND NOT EXISTS (
        SELECT 1 FROM agent_api_keys k
        WHERE k.agent_id = a.id AND k.revoked_at IS NULL
      )
    ORDER BY a.created_at
  `);

  console.log(`Found ${agentsNeedingKeys.length} agents without active keys`);

  let created = 0;
  for (const agent of agentsNeedingKeys) {
    const token = createToken();
    const keyHash = hashToken(token);
    await client.query(
      `INSERT INTO agent_api_keys (agent_id, company_id, name, key_hash) VALUES ($1, $2, $3, $4)`,
      [agent.id, agent.company_id, "phase-1.11-mqtt-bootstrap", keyHash],
    );
    created++;
    console.log(`  + ${agent.id}  ${agent.name}`);
  }

  console.log(`\nProvisioned ${created} keys`);

  const { rows: stats } = await client.query(`
    SELECT
      (SELECT count(*) FROM agents WHERE status != 'terminated') AS total_agents,
      (SELECT count(DISTINCT agent_id) FROM agent_api_keys WHERE revoked_at IS NULL) AS agents_with_keys
  `);
  console.log("After:", stats[0]);
} finally {
  client.release();
  await pool.end();
}
