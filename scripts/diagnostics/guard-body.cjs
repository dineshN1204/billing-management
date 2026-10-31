const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.proname, p.prosecdef::text secdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname in ('guard_soft_delete','normalize_customer_fields')`);
  for (const x of r.rows) {
    console.log('========== ' + x.proname + '  secdef=' + x.secdef + ' ==========');
    x.def.split('\n').forEach((l, i) => { if (/auth\./i.test(l)) console.log('  >>> ' + (i + 1) + ': ' + l.trim()) });
    console.log(x.def);
    console.log();
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
