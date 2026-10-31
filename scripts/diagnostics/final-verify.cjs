const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> rows=' + r.rowCount + ' ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
(async () => {
  await c.connect();
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  console.log('org=' + ORG + ' user=' + UID);

  const before = await c.query(`select id, name, phone, email, city from public.customers where organization_id='${ORG}' and deleted_at is null order by name limit 3`);
  console.log('existing customers:', JSON.stringify(before.rows));
  const CID = before.rows[0].id;

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  console.log('\n--- as authenticated, current_user=' + (await c.query(`select current_user u`)).rows[0].u + ' ---');
  await show('SELECT customers', `select id, name from public.customers where organization_id='${ORG}' and deleted_at is null order by name`);
  await show('UPDATE existing customer', `
    update public.customers
    set name='ZZ Probe Edited', phone='9999000011', email='probe@example.com',
        address_line_1='12 Test Street', city='Chennai', state='Tamil Nadu', pincode='600001', country='India'
    where id='${CID}' returning id, name, phone, email, address_line_1, city, pincode`);
  await show('INSERT new customer', `
    insert into public.customers (organization_id, name, phone, email, address_line_1, city, state, pincode, country)
    values ('${ORG}','ZZ New Probe','9999000022','new@example.com','9 New Road','Chennai','Tamil Nadu','600002','India')
    returning id, name, phone, email, city`);
  await c.query('rollback');
  console.log('\n(rolled back - no data changed)');

  console.log('\n--- schema snapshot ---');
  const cols = await c.query(`select column_name from information_schema.columns where table_name='bills' and column_name like 'customer%' order by ordinal_position`);
  cols.rows.forEach(x => console.log('  bills.' + x.column_name));
  const custCols = await c.query(`select column_name from information_schema.columns where table_name='customers' order by ordinal_position`);
  console.log('customers columns: ' + custCols.rows.map(x => x.column_name).join(', '));
  await c.end();
})().catch(e => { console.error('FATAL', e.code, e.message); c.end().catch(()=>{}); process.exit(1); });
