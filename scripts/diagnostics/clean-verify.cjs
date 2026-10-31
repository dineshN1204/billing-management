// CLEAN verification: NO grants performed. Only tests whether authenticated can insert/update.
const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
(async () => {
  await c.connect();
  const acl = await c.query(`select nspacl from pg_namespace where nspname='auth'`);
  console.log('AUTH SCHEMA ACL:', acl.rows[0].nspacl);
  console.log('has_schema_privilege(authenticated, auth, USAGE) =',
    (await c.query(`select has_schema_privilege('authenticated','auth','USAGE') u`)).rows[0].u);
  console.log('has_function_privilege(authenticated, auth.uid(), EXECUTE) =',
    (await c.query(`select has_function_privilege('authenticated','auth.uid()','EXECUTE') x`)).rows[0].x);

  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  console.log('\norg', ORG, 'user', UID);

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);

  console.log('\n=== as authenticated ===');
  await show('direct auth.uid() call', `select auth.uid() uid`);
  await show('is_org_member', `select app_private.is_org_member('${ORG}'::uuid) m`);
  await show('INSERT customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Clean Probe',null,'9999000011','c@e.com',null,'1 A St',null,'Chennai','Tamil Nadu','600001','India','33',null)
    returning id, name`);
  const ex = await c.query(`select id from public.customers where organization_id='${ORG}' and deleted_at is null limit 1`);
  await show('UPDATE customer', `
    update public.customers set name=name||' (x)', phone='9999000099', email='x@e.com', city='Madurai', pincode='600002'
    where id='${ex.rows[0].id}' returning id, name, phone, email, city`);
  await show('SELECT customer', `select id, name, phone, email, city from public.customers where id='${ex.rows[0].id}'`);
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
