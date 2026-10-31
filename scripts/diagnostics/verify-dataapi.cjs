// Determine what the Neon Data API actually does: it connects as neondb_owner
// and sets request.jwt.claims (it does NOT "set role authenticated").
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
  console.log('org=' + ORG + ' user=' + UID + '  (Data API style: role stays neondb_owner)\n');

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);

  await show('auth.uid() as owner', `select auth.uid() uid`);
  await show('select customers', `select count(*) n from public.customers`);
  await show('select bills', `select count(*) n from public.bills`);

  console.log('\n--- INSERT (new customer) ---');
  await show('insert customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Probe Co',null,'9999000011','p@e.com',null,'12 Test St',null,'Chennai','Tamil Nadu','600001','India','33',null)
    returning id, name, phone, email, city, pincode, country`);

  console.log('\n--- UPDATE (edit existing customer) ---');
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
