const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='current_uid'`);
  if (!r.rowCount) console.log('app_private.current_uid DOES NOT EXIST');
  r.rows.forEach(x => console.log(x.nspname + '.' + x.proname + '(' + x.args + ') secdef=' + x.prosecdef + '\n' + x.def));
  console.log('\n--- grants on auth schema (raw) ---');
  const g = await c.query(`select has_schema_privilege('authenticated','auth','USAGE') u, has_schema_privilege('anonymous','auth','USAGE') anon_u`);
  console.log(JSON.stringify(g.rows));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
