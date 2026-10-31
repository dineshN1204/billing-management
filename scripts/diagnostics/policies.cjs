const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  console.log('##### RLS policies on customers #####');
  const p = await c.query(`select policyname, cmd, roles, qual, with_check from pg_policies where tablename='customers'`);
  p.rows.forEach(x => console.log(`\n[${x.cmd}] ${x.policyname} roles=${x.roles}\n  USING: ${x.qual}\n  CHECK: ${x.with_check}`));

  console.log('\n##### UPDATE-only trigger funcs (non-secdef) #####');
  for (const fn of ['set_updated_at','enforce_immutable_columns','guard_soft_delete','is_org_admin']) {
    const r = await c.query(`select p.prosecdef, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname=$1`, [fn]);
    console.log('\n=== ' + fn + ' secdef=' + r.rows[0].prosecdef + ' ===\n' + (r.rows[0]?.def ?? '(none)'));
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.code, e.message); c.end().catch(()=>{}); process.exit(1); });
