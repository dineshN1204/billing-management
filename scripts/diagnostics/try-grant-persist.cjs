const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const UNPOOLED = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: UNPOOLED, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' (' + r.rowCount + ') ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  await show('owner of schema auth', `select n.nspname, pg_get_userbyid(n.nspowner) owner from pg_namespace n where n.nspname='auth'`);
  await show('can I become cloud_admin?', `select pg_has_role(current_user,'cloud_admin','MEMBER') m, pg_has_role(current_user,'cloud_admin','USAGE') u`);
  await show('grant options on auth', `select has_schema_privilege(current_user,'auth','USAGE') usage, has_schema_privilege(current_user,'auth','CREATE') create`);

  // Attempt: SET ROLE to cloud_admin then grant
  try {
    await c.query(`set role cloud_admin`);
    await show('after set role cloud_admin', `select current_user`);
    await show('grant usage attempt', `grant usage on schema auth to authenticated`);
    await show('grant execute attempt', `grant execute on all functions in schema auth to authenticated`);
    await c.query(`reset role`);
  } catch (e) { console.log('set role cloud_admin FAILED:', e.code, e.message) }

  await show('acl after attempts', `select nspname, nspacl from pg_namespace where nspname='auth'`);
  await show('has usage authenticated', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
