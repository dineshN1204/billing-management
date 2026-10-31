const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/^DATABASE_URL="(.+)"$/m);
const c = new Client({ connectionString: m[1], ssl: { rejectUnauthorized: false } });
const show = async (label, sql, params) => {
  const r = await c.query(sql, params);
  console.log('\n=== ' + label + ' ===');
  r.rows.forEach(x => console.log(JSON.stringify(x)));
};
c.connect().then(async () => {
  await show('GRANTS on customers', `
    select grantee, string_agg(distinct privilege_type, ',' order by privilege_type) privs
    from information_schema.role_table_grants
    where table_schema='public' and table_name='customers' and grantee in ('authenticated','anon','public')
    group by grantee`);
  await show('COLUMN GRANTS on customers', `
    select grantee, string_agg(column_name, ',' order by column_name) cols, string_agg(distinct privilege_type, ',') privs
    from information_schema.column_privileges
    where table_schema='public' and table_name='customers' and grantee in ('authenticated','anon')
    group by grantee, privilege_type`);
  await show('RLS policies customers', `select policyname, cmd, roles, qual, with_check from pg_policies where schemaname='public' and tablename='customers'`);
  await show('RLS enabled', `select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname in ('customers','bills')`);
  await show('TRIGGERS customers', `select tgname, pg_get_triggerdef(oid) def from pg_trigger where tgrelid='public.customers'::regclass and not tgisinternal`);
  await show('CONSTRAINTS customers', `select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.customers'::regclass order by conname`);
  await show('ROLES', `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('authenticated','anon','service_role','neondb_owner')`);
  await c.end();
}).catch(e => { console.error('ERR', e.message, e.detail, e.position); process.exit(1); });
