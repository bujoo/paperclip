#!/usr/bin/env node
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'paperclip_local',
  user: 'paperclip',
  password: 'paperclip',
});

async function main() {
  const res = await pool.query(
    `SELECT id, name, accountabilities FROM public.agents WHERE id = 'e1f66962-dc3c-4a8e-9875-de1a1dee2839'`
  );
  console.log(JSON.stringify(res.rows[0], null, 2));
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
