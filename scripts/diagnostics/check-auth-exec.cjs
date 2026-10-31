const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const POOLED = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const UNPOOLED = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const show = async (c, l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
async function check(endpoint, label) {
  console.log('\n######### ' + label + ' #########');
  const c = new Client({ connectionString: endpoint, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await show(c, 'auth function ACLs', `
    select p.proname, p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='auth' order by p.proname`);
  await show(c, 'authenticated can execute', `
    select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') can_exec
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' order by p.proname`);
  await show(c, 'which funcs does the app need (used in migrations)', `
    select distinct m.fname, (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='auth' and p.proname=m.fname) exists_count
    from (values ('uid'),('role'),('jwt'),('email'),('user_id')) m(fname)`);
  await c.end();
}
(async () => {
  await check(POOLED, 'POOLED');
  await check(UNPOOLED, 'UNPOOLED');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
