const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  console.log('grant option check:', JSON.stringify((await c.query(`select has_schema_privilege('neondb_owner','auth','USAGE') u,
    has_schema_privilege('neondb_owner','auth','USAGE WITH GRANT OPTION') ugo,
    has_schema_privilege('neondb_owner','auth','CREATE') c`)).rows));

  const r = await c.query(`select n.nspname, p.proname, p.prosecdef::text secdef,
    pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('app_private','public') order by n.nspname, p.proname`);
  console.log('\nFunctions referencing auth.uid()/auth.jwt()/auth.role():');
  for (const x of r.rows) {
    const uses = (x.def.match(/auth\.\s*(uid|role|jwt)\s*\(/g) || []);
    if (uses.length) {
      console.log(`  ${x.nspname}.${x.proname}(${x.args}) secdef=${x.secdef} uses=${[...new Set(uses)].join(',')}`);
    }
  }

  console.log('\nAll triggers on public.customers:');
  (await c.query(`
    select t.tgname, p.proname fn, p.prosecdef::text secdef, t.tgtype
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where t.tgrelid='public.customers'::regclass and not t.tgisinternal
    order by t.tgname`)).rows.forEach(x => console.log('  ' + JSON.stringify(x)));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
