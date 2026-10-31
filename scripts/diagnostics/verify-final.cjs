// Final verification: prove that customer UPDATE now works as the `authenticated`
// role (the exact operation that was failing in the app with
// "The request could not be completed. Please try again.")
const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, q, p) => {
  try { const r = await c.query(q, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
(async () => {
  await c.connect();
  const t = await c.query(`select o.id org, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id limit 1`);
  const ORG = t.rows[0].org, UID = t.rows[0].user_id;
  console.log('org=' + ORG + ' user=' + UID);

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);

  console.log('\n--- auth schema access ---');
  await show('has_schema_privilege(auth,USAGE)', `select has_schema_privilege('authenticated','auth','USAGE') u`);
  await show('auth.uid() direct call', `select auth.uid() uid`);

  console.log('\n--- SELECT ---');
  await show('select customers', `select count(*) n from public.customers`);
  await show('select bills', `select count(*) n from public.bills`);

  console.log('\n--- INSERT (new customer) ---');
  await show('insert customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Probe Co',null,'9999000011','p@e.com',null,'12 Test St',null,'Chennai','Tamil Nadu','600001','India','33',null)
    returning id, name, phone, email, city, pincode, country`);

  console.log('\n--- UPDATE (edit existing customer) <-- this was the failing one ---');
  const ex = await c.query(`select id, name from public.customers where organization_id='${ORG}' limit 1`);
  if (ex.rowCount) {
    await show('update customer', `
      update public.customers set name=name||' (edited)', phone='9999000099', email='edit@example.com',
        address_line_1='9 New Road', city='Chennai', state='Tamil Nadu', pincode='600002', country='India', gstin=null
      where id='${ex.rows[0].id}' returning id, name, phone, email, city, pincode`);
  } else console.log('(no existing customer row to edit)');
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
