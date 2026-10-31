const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const step = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? []).slice(0, 400)); return r }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message); throw e }
};
(async () => {
  await c.connect();
  console.log('##### applying migration 0010 #####');
  const sql = fs.readFileSync('db/migrations/0010_fix_auth_uid_in_triggers.sql', 'utf8');
  await c.query(sql);
  console.log('migration applied\n');

  await step('secdef flags after', `
    select p.proname, p.prosecdef secdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname in
      ('normalize_customer_fields','guard_soft_delete','set_updated_at','enforce_immutable_columns','current_uid')
    order by p.proname`);

  await step('normalize no longer calls auth.uid() directly', `
    select pg_get_functiondef(oid) def from pg_proc
    where proname='normalize_customer_fields'`)
    .then(r => console.log('   contains auth.uid():', /auth\.\s*uid\s*\(/.test(r.rows[0].def),
                          '| contains current_uid():', /app_private\.current_uid\s*\(/.test(r.rows[0].def)));

  console.log('\n##### end-to-end as authenticated #####');
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  console.log('org', ORG, 'user', UID);

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  await step('INSERT customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address_line_1, city, state, pincode, country, state_code)
    values ('${ORG}','Migration Test',null,'9999000011','m@e.com','12 Test St','Chennai','Tamil Nadu','600001','India','33')
    returning id, name, phone, email, city, pincode`);
  const one = await c.query(`select id from public.customers where organization_id='${ORG}' limit 1`);
  const id = one.rows[0].id;
  await step('UPDATE customer', `
    update public.customers set name=name||' (edited)', phone='9999000099', email='edit@e.com',
      address_line_1='9 New Road', city='Madurai', pincode='600002'
    where id='${id}' returning id, name, phone, email, city, pincode`);
  await c.query('rollback');
  await c.end();
  console.log('\nALL GOOD');
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
