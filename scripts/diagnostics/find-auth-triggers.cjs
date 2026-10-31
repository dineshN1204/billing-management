const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select n.nspname, p.proname, p.prosecdef::text secdef, pg_get_userbyid(p.proowner) owner,
           pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('app_private','public') order by p.proname`);
  console.log('=== functions that reference auth.uid()/auth.role()/auth.jwt() ===');
  for (const x of r.rows) {
    if (/auth\.\s*(uid|role|jwt)/i.test(x.def)) {
      console.log(`${x.nspname}.${x.proname}  secdef=${x.secdef}  owner=${x.owner}`);
    }
  }
  console.log('\n=== triggers on public.customers (in firing order) ===');
  const t = await c.query(`
    select t.tgname, p.proname fn, t.tgtype, p.prosecdef::text secdef,
           case when (t.tgtype & 4) > 0 then 'INSERT' else '' end ||
           case when (t.tgtype & 8) > 0 then ' DELETE' else '' end ||
           case when (t.tgtype & 16) > 0 then ' UPDATE' else '' end as timing_events,
           pg_get_triggerdef(t.oid) def
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    join pg_class cl on cl.oid=t.tgrelid
    where cl.relname='customers' and not t.tgisinternal order by t.tgname`);
  t.rows.forEach(x => console.log(`${x.tgname} -> ${x.fn} secdef=${x.secdef} [${x.timing_events}]`));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
