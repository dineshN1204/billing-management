const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' (' + r.rowCount + ') ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  await show('my roles', `select current_user, session_user, usesuper from pg_user where usename=current_user`);
  await show('is member of cloud_admin?', `select pg_has_role(current_user,'cloud_admin','MEMBER') m, pg_has_role(current_user,'cloud_admin','USAGE') u, pg_has_role('cloud_admin', current_user, 'MEMBER') cm`);
  await show('auth acl BEFORE', `select nspacl from pg_namespace where nspname='auth'`);
  console.log('attempting: grant usage on schema auth to authenticated');
  try { await c.query(`grant usage on schema auth to authenticated`); console.log('  -> accepted'); }
  catch (e) { console.log('  -> REJECTED:', e.code, e.message); }
  await show('auth acl AFTER', `select nspacl from pg_namespace where nspname='auth'`);
  await show('has_schema_privilege(authenticated, auth, USAGE)', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
