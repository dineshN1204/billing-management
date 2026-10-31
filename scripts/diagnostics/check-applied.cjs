const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.proname, p.prosecdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' order by p.proname`);
  for (const x of r.rows) {
    const usesCurrentUid = /current_uid\s*\(/.test(x.def);
    const usesDirectAuth = /auth\.\s*(uid|role|jwt)\s*\(/.test(x.def);
    console.log(
      (x.prosecdef ? 'D' : '-') +
      (usesCurrentUid ? 'U' : ' ') +
      (usesDirectAuth ? 'A' : ' ') +
      '  ' + x.proname
    );
  }
  console.log('\nlegend: D=SECURITY DEFINER, U=uses current_uid(), A=uses auth.uid() directly');
  console.log('\n=== current_uid() present? ===');
  const cu = await c.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname='current_uid'`);
  console.log('current_uid exists:', cu.rowCount > 0);
  const cols = await c.query(`select column_name from information_schema.columns where table_name='bills' and column_name like 'customer_%' order by column_name`);
  console.log('\n=== bills.customer_* columns ===');
  cols.rows.forEach(x => console.log(x.column_name));
  const trg = await c.query(`select tgname from pg_trigger where tgrelid='public.bills'::regclass and not tgisinternal`);
  console.log('\n=== triggers on public.bills ===');
  trg.rows.forEach(x => console.log(x.tgname));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
