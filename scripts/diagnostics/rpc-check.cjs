const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname in ('save_bill','update_bill','upsert_bill','bill_json') order by p.proname`);
  r.rows.forEach(x => console.log(x.nspname + '.' + x.proname + '(' + x.args + ') secdef=' + x.prosecdef));
  console.log('---- v_customer declaration in upsert_bill ----');
  const b = await c.query(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname='upsert_bill'`);
  const def = b.rows[0].def;
  console.log(def.split('\n').slice(0, 40).join('\n'));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
