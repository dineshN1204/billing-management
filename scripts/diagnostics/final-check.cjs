const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql) => {
  try { const r = await c.query(sql); console.log('=== ' + l + ' ==='); r.rows.forEach(x => console.log('  ' + JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERR === ' + e.code + ' ' + e.message) }
};
(async () => {
  await c.connect();
  await show('auth schema usage for authenticated', `select has_schema_privilege('authenticated','auth','USAGE') usage, has_schema_privilege('authenticated','auth','CREATE') create`);
  await show('auth fn exec', `select has_function_privilege('authenticated','auth.uid()','EXECUTE') uid_x, has_function_privilege('authenticated','auth.jwt()','EXECUTE') jwt_x, has_function_privilege('authenticated','auth.role()','EXECUTE') role_x`);
  await show('nspacl', `select nspname, nspacl::text acl from pg_namespace where nspname='auth'`);
  await show('bills columns', `select column_name, data_type from information_schema.columns where table_name='bills' order by ordinal_position`);
  await show('customers columns', `select column_name, data_type from information_schema.columns where table_name='customers' order by ordinal_position`);
  await show('bill column grants', `select grantee, privilege_type from information_schema.column_privileges where table_name='bills' and column_name in ('customer_phone','customer_email','customer_address') and grantee='authenticated'`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
