// Apply the auth-schema grants the same way migration 0010 does.
const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, q) => {
  try { const r = await c.query(q); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  await show('apply: grant usage on schema auth', `grant usage on schema auth to authenticated`);
  await show('apply: grant execute on all functions in schema auth', `grant execute on all functions in schema auth to authenticated`);
  try {
    await show('apply: default privileges for cloud_admin', `alter default privileges for role cloud_admin in schema auth grant execute on functions to authenticated`);
  } catch (e) { console.log('SKIP  default privileges -> ' + e.code + ' | ' + e.message) }
  await show('verify nspacl', `select nspname, nspacl from pg_namespace where nspname='auth'`);
  await show('verify has_schema_privilege', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  await show('verify func exec', `select has_function_privilege('authenticated','auth.uid()','EXECUTE') uid_x, has_function_privilege('authenticated','auth.jwt()','EXECUTE') jwt_x`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
