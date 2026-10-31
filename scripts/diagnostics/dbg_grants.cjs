const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, p) => (await c.query(sql, p)).rows;
(async () => {
  await c.connect();
  console.log('whoami:', JSON.stringify(await q(`select current_user cu, session_user su`)));
  console.log('event triggers:', JSON.stringify(await q(`
    select evtname, evtevent, evtenabled, evtfoid::regprocedure fn from pg_event_trigger`)));
  console.log('grant attempts (verbose):');
  for (const s of [
    `grant usage on schema auth to authenticated`,
    `grant usage on schema auth to anon`,
    `create schema _probe_acl`,
    `grant usage on schema _probe_acl to authenticated`,
  ]) {
    try { await c.query(s); console.log('  OK   ', s) }
    catch (e) { console.log('  ERR  ', s, '->', e.code, e.message) }
  }
  console.log('acl after in THIS session:', JSON.stringify(await q(`select nspname, nspacl from pg_namespace where nspname='auth'`)));
  console.log('has usage (this session):', JSON.stringify(await q(`select has_schema_privilege('authenticated','auth','USAGE') u`)));
  const c2 = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c2.connect();
  console.log('FRESH CONN auth acl:', JSON.stringify(await c2.query(`select nspname, nspacl from pg_namespace where nspname='auth'`).then(r => r.rows)));
  console.log('FRESH CONN probe schema acl:', JSON.stringify(await c2.query(`select nspname, nspacl from pg_namespace where nspname='_probe_acl'`).then(r => r.rows)));
  await c2.end();
  // The probe schema is created above purely to watch a GRANT land; dropping it is
  // best-effort cleanup. A silent catch hid the reason when the drop itself failed.
  try { await c.query(`drop schema _probe_acl`) } catch (dropError) { console.log('probe schema not dropped:', dropError.code || dropError.message) }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
