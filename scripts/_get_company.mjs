import pgModule from '/Users/tom/paperclip/node_modules/.pnpm/pg@8.18.0/node_modules/pg/lib/index.js';
const c = new pgModule.Client({host:'127.0.0.1', port:54329, user:'paperclip', database:'paperclip', password:'paperclip'});
await c.connect();
const r = await c.query("SELECT id, name FROM public.companies");
console.log('Companies:', r.rows);
await c.end();
