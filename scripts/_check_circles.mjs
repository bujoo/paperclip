import pgModule from '/Users/tom/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js';
const c = new pgModule.Client({host:'127.0.0.1', port:54329, user:'paperclip', database:'paperclip', password:'paperclip'});
await c.connect();
const r = await c.query(`SELECT c.id, c.company_id, c.name,
  (SELECT COUNT(DISTINCT ra.agent_id)::int FROM plugin_holacracy_c5049b5dfe.role_assignments ra
   JOIN plugin_holacracy_c5049b5dfe.roles r ON r.id = ra.role_id WHERE r.circle_id = c.id) AS members
FROM plugin_holacracy_c5049b5dfe.circles c ORDER BY name LIMIT 80`);
console.log('Circles + member count:');
for (const row of r.rows) {
  console.log(`  ${row.name.padEnd(50)} members=${row.members} company=${row.company_id.slice(0,8)} id=${row.id}`);
}
const ag = await c.query(`SELECT a.id, a.name, a.status, a.adapter_type, a.company_id,
  (SELECT cc.name FROM plugin_holacracy_c5049b5dfe.circles cc
    JOIN plugin_holacracy_c5049b5dfe.roles rr ON rr.circle_id = cc.id
    JOIN plugin_holacracy_c5049b5dfe.role_assignments rra ON rra.role_id = rr.id
    WHERE rra.agent_id = a.id LIMIT 1) AS circle_name
  FROM public.agents a WHERE a.status NOT IN ('archived','terminated') ORDER BY a.created_at DESC LIMIT 30`);
console.log('\nAgents (status not archived/terminated):');
for (const row of ag.rows) {
  console.log(`  ${(row.name||'').padEnd(30)} adapter=${(row.adapter_type||'none').padEnd(15)} circle=${row.circle_name||'-'} id=${row.id.slice(0,8)}`);
}
await c.end();
