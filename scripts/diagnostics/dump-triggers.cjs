const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  for (const f of ['set_updated_at', 'enforce_immutable_columns', 'guard_soft_delete', 'normalize_customer_fields']) {
    const r = await c.query(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app_private' and p.proname=$1`, [f]);
    console.log('\n===================== ' + f + ' =====================');
    console.log(r.rows[0].def);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
