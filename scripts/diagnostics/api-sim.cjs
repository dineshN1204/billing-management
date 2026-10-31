const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const POOLED = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
const c = new Client({ connectionString: POOLED, ssl: { rejectUnauthorized: false } });

(async () => {
  await c.connect();
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;

  // Emulate exactly what the Neon Data API does: SET LOCAL ROLE + claims, then normal DML
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);

  console.log('=== SELECT ===');
  await show('customers visible', `select count(*) n from public.customers`);
  await show('bills visible', `select count(*) n from public.bills`);

  console.log('\n=== INSERT (CustomerForm "Add customer") ===');
  await show('insert customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Qa Co',null,'9999000011','qa@e.com',null,'1 A St',null,'Chennai','Tamil Nadu','600001','India','33',null) returning id, name`);

  console.log('\n=== UPDATE (CustomerForm "Save changes" -> the user\'s error) ===');
  const ex = await c.query(`select id, name from public.customers where organization_id='${ORG}' and deleted_at is null limit 1`);
  await show('update customer (all fields)', `
    update public.customers set name=$2, gstin=$3, phone=$4, email=$5, address=$6,
      address_line_1=$7, address_line_2=$8, city=$9, state=$10, pincode=$11, country=$12, state_code=$13, notes=$14
    where id=$1 and organization_id=$15 returning id, name, phone, email, city, pincode`,
    [ex.rows[0].id, 'Qa Co Edited', null, '9999000099', 'qa2@e.com', null, '9 B Rd', null, 'Madurai', 'Tamil Nadu', '600002', 'India', '33', 'note', ORG]);

  console.log('\n=== RPC save_bill (bill generation) ===');
  await show('save_bill', `select public.save_bill($1) r`, [JSON.stringify({
    organization_id: ORG,
    customer_id: ex.rows[0].id,
    bill_number: 'QA-1',
    bill_date: '2026-01-15',
    tax_mode: 'intra',
    place_of_supply: 'Tamil Nadu',
    payment_status: 'unpaid',
    source_type: 'manual',
    verification_status: 'verified',
    items: [{ product_name: 'Widget', quantity: '2', rate: '100', discount: '0', gst_rate: '18' }],
  })]);

  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
