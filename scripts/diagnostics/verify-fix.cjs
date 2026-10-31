const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/^DATABASE_URL="(.+)"$/m);
const c = new Client({ connectionString: m[1], ssl: { rejectUnauthorized: false } });
const ORG = 'a945ffdf-8248-45c2-912e-8ab7e5f8f887';
const UID = 'b91f0088-2fd0-49c2-8cc0-5b5af6593c26';
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
(async () => {
  await c.connect();
  await show('schema auth acl exploded', `
    select n.nspname, g.rolname grantee, p.privilege_type
    from pg_namespace n cross join lateral aclexplode(n.nspacl) g
    join lateral (select unnest(array['USAGE','CREATE']) with ordinality t(privilege_type, ord)) p
      on p.ord = case g.privilege_type when 'U' then 1 when 'C' then 2 else 1 end
    where n.nspname = 'auth'`);
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  await show('whoami', `select current_user u`);
  await show('auth.uid()', `select auth.uid() uid`);
  await show('is_org_member', `select app_private.is_org_member('${ORG}'::uuid) m`);
  await show('can_write', `select app_private.can_write('${ORG}'::uuid) w`);
  await show('select customers', `select count(*) n from public.customers`);
  await show('INSERT customer (full record)', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Probe Co',null,'9999000011','p@e.com',null,'12 Test St',null,'Chennai','Tamil Nadu','600001','India','33',null) returning id, name`);
  await c.query('rollback');

  console.log('\n--- now test UPDATE (the user\'s edit failure) ---');
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  const cust = await c.query(`select id from public.customers where organization_id='${ORG}' and deleted_at is null limit 1`);
  if (cust.rowCount) {
    const cid = cust.rows[0].id;
    await show('UPDATE existing customer', `
      update public.customers set name=name || ' (edited)', phone='9999000099', email='edit@example.com',
        address_line_1='9 New Road', city='Chennai', state='Tamil Nadu', pincode='600002', country='India'
      where id='${cid}' returning id, name, phone, email, city, pincode`);
  } else { console.log('no existing customer to edit') }
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
