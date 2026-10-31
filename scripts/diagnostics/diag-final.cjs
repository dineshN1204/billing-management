const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' (' + r.rowCount + ') ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  await show('OVERLOADS named guard_soft_delete / set_updated_at', `
    select n.nspname, p.proname, p.oid::regprocedure sig, p.prosecdef, pg_get_userbyid(p.proowner) owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname in ('guard_soft_delete','set_updated_at') order by p.proname, n.nspname`);
  await show('triggers on public.customers', `
    select t.tgname, p.proname fn, t.tgenabled, n.nspname fnnsp
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
    where t.tgrelid='public.customers'::regclass and not t.tgisinternal order by t.tgname`);
  await show('ACL explode BEFORE', `select g.grantee::regrole grantee, g.privilege_type from pg_namespace n, aclexplode(n.nspacl) g where n.nspname='auth'`);

  console.log('\n--- GRANT attempt 1: to authenticated ---');
  let r = await c.query(`grant usage on schema auth to authenticated`);
  console.log('tag:', r.command);
  await show('ACL explode AFTER', `select g.grantee::regrole grantee, g.privilege_type from pg_namespace n, aclexplode(n.nspacl) g where n.nspname='auth'`);

  console.log('\n--- GRANT attempt 2: to public ---');
  r = await c.query(`grant usage on schema auth to public`);
  console.log('tag:', r.command);
  await show('ACL explode AFTER2', `select g.grantee::regrole grantee, g.privilege_type from pg_namespace n, aclexplode(n.nspacl) g where n.nspname='auth'`);
  await show('has_schema_privilege authenticated', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
