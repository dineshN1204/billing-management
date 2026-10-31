const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};

(async () => {
  await c.connect();

  const org = await c.query(`
    select o.id, m.user_id, m.role
    from public.organizations o
    join public.memberships m on m.organization_id = o.id
    where (select count(*) from public.customers x where x.organization_id = o.id) > 0
    limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  const cust = await c.query(`select id, name from public.customers where organization_id=$1 and deleted_at is null limit 1`, [ORG]);
  const CID = cust.rows[0].id;
  console.log('org=' + ORG + ' user=' + UID + ' role=' + org.rows[0].role + ' customer=' + CID + ' ' + cust.rows[0].name);

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);

  await show('select customers (RLS)', `select count(*) n from public.customers`);
  await show('INSERT customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ($1,'Probe Co',null,'9999000011','p@e.com',null,'12 Test St',null,'Chennai','Tamil Nadu','600001','India','33',null)
    returning id, name, phone, email, city, pincode, country`, [ORG]);
  await show('UPDATE customer (THE BUG)', `
    update public.customers set name=name||' (edited)', phone='9999000099', email='edit@example.com',
      address_line_1='9 New Road', city='Chennai', state='Tamil Nadu', pincode='600002', country='India'
    where id=$1 returning id, name, phone, email, city, pincode`, [CID]);
  await show('SOFT DELETE customer (THE BUG)', `
    update public.customers set deleted_at=now() where id=$1 returning id, deleted_at`, [CID]);
  await show('UPDATE product', `
    update public.products set default_rate=default_rate, name=name||' x' where organization_id=$1 returning id, name limit 1`, [ORG]);
  await show('UPDATE bill', `
    update public.bills set notes=coalesce(notes,'')||'x' where organization_id=$1 returning id, bill_number limit 1`, [ORG]);
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
