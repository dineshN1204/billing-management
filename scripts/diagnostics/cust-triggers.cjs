const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const t = await c.query(`
    select t.tgname, t.tgtype, p.proname, pg_get_function_identity_arguments(p.oid) args,
           p.prosecdef::text secdef, pg_get_userbyid(p.proowner) owner,
           pg_get_functiondef(p.oid) def,
           t.tgenabled, t.tgdeferrable, t.tginitdeferred
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.customers'::regclass and not t.tgisinternal
    order by t.tgname`);
  console.log('### triggers on public.customers: ' + t.rowCount + ' ###');
  for (const r of t.rows) {
    console.log('\n--- ' + r.tgname + ' | ' + r.proname + ' | secdef=' + r.secdef + ' | owner=' + r.owner +
      ' | events=' + (r.tgtype & 4 ? 'INSERT ' : '') + (r.tgtype & 8 ? 'DELETE ' : '') + (r.tgtype & 16 ? 'UPDATE ' : '') +
      ' | timing=' + (r.tgtype & 2 ? 'BEFORE' : r.tgtype & 64 ? 'INSTEAD' : 'AFTER') + ' | row=' + (r.tgtype & 1 ? 'ROW' : 'STATEMENT'));
    if (/auth\./i.test(r.def)) console.log('    >>> REFERENCES auth.* <<<');
    console.log(r.def);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
