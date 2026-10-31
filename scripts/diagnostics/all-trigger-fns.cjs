const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  // all trigger functions referencing auth. that are NOT security definer
  const fns = await c.query(`
    select n.nspname, p.proname, p.prosecdef::text secdef, pg_get_userbyid(p.proowner) owner,
           pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prorettype = 'trigger'::regtype
    order by secdef, n.nspname, p.proname`);
  console.log('### ALL trigger functions: ' + fns.rowCount + ' ###\n');
  for (const f of fns.rows) {
    const usesAuth = /auth\.\s*(uid|role|jwt|email)/i.test(f.def);
    console.log(`${f.secdef === 'true' ? '[DEFINER] ' : '[INVOKER]'} ${f.nspname}.${f.proname}(${f.args}) owner=${f.owner}${usesAuth ? '  *** CALLS auth.* ***' : ''}`);
  }
  const bad = fns.rows.filter(f => f.secdef === 'false' && /auth\.\s*(uid|role|jwt|email)/i.test(f.def));
  console.log('\n\n### PROBLEM FUNCTIONS (INVOKER + calls auth.*): ' + bad.length + ' ###');
  for (const f of bad) console.log('  ' + f.nspname + '.' + f.proname);

  // which tables do they trigger on
  console.log('\n### affected tables ###');
  for (const f of bad) {
    const tg = await c.query(`
      select t.tgrelid::regclass::text tbl, t.tgname,
        (t.tgtype & 4 <> 0) ins, (t.tgtype & 8 <> 0) del, (t.tgtype & 16 <> 0) upd
      from pg_trigger t where t.tgfoid = (select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=$1 and p.proname=$2 and pg_get_function_identity_arguments(p.oid)=$3)
        and not t.tgisinternal`, [f.nspname, f.proname, f.args]);
    for (const g of tg.rows) console.log(`  ${f.proname} -> ${g.tbl} (${g.tgname}) INSERT=${g.ins} DELETE=${g.del} UPDATE=${g.upd}`);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
