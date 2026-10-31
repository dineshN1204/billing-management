const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const sql = fs.readFileSync('db/migrations/0011_secdef_auth_trigger_fixes.sql', 'utf8');
  await c.query(sql);
  console.log('migration 0011 applied');
  const r = await c.query(`
    select p.proname, p.prosecdef::text secdef
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname in ('current_uid','guard_soft_delete','write_audit_row','normalize_customer_fields')
    order by p.proname`);
  r.rows.forEach(x => console.log('  ' + x.proname + ' secdef=' + x.secdef));
  await c.end();
})().catch(e => { console.error('FATAL', e.code, e.message); c.end(); process.exit(1); });
