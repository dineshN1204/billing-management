const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.proname, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname in
      ('enforce_immutable_columns','guard_soft_delete','guard_last_admin','block_audit_mutation','set_updated_at')
    order by p.proname`);
  for (const x of r.rows) {
    console.log('\n========== ' + x.proname + ' ==========');
    console.log(x.def);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
