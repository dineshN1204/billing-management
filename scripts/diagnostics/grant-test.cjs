const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  await show('before: nspacl', `select nspname, nspacl from pg_namespace where nspname='auth'`);
  const g = await c.query(`grant usage on schema auth to authenticated`);
  console.log('grant command tag:', JSON.stringify(g));
  await show('immediately after: nspacl', `select nspname, nspacl from pg_namespace where nspname='auth'`);
  await show('has_schema_privilege', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  // Try in an explicit txn and commit
  await c.query('begin');
  await c.query(`grant usage on schema auth to authenticated`);
  await show('in txn: nspacl', `select nspname, nspacl from pg_namespace where nspname='auth'`);
  await c.query('commit');
  await show('after commit: nspacl', `select nspname, nspacl from pg_namespace where nspname='auth'`);
  await show('has_schema_privilege after commit', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  await show('grantable by me?', `
    select pg_has_role(current_user, 'cloud_admin', 'MEMBER') m, pg_has_role(current_user,'cloud_admin','USAGE') u`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
