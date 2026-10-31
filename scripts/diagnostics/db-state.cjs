const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' (' + r.rowCount + ') ==='); r.rows.forEach(x => console.log('  ' + JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  console.log('\n##### 1. customers columns #####');
  const cc = await c.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='customers' order by ordinal_position`);
  cc.rows.forEach(x => console.log('  ' + x.column_name.padEnd(22) + ' ' + x.data_type.padEnd(26) + ' null=' + x.is_nullable + ' def=' + x.column_default));

  console.log('\n##### 2. bills columns #####');
  const bc = await c.query(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='bills' order by ordinal_position`);
  bc.rows.forEach(x => console.log('  ' + x.column_name.padEnd(22) + ' ' + x.data_type.padEnd(26) + ' null=' + x.is_nullable + ' def=' + x.column_default));

  console.log('\n##### 3. column grants on customers/bills #####');
  await show('grants', `
    select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
    from information_schema.column_privileges
    where table_schema='public' and table_name in ('customers','bills') and grantee in ('authenticated','anonymous')
    group by table_name, grantee`);

  console.log('\n##### 4. secdef of trigger functions on customers #####');
  await show('secdef', `
    select distinct p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' order by p.proname`);

  console.log('\n##### 5. re-run original INSERT repro #####');
  const org = await c.query(`select o.id, m.user_id from public.organizations o join public.memberships m on m.organization_id=o.id order by o.created_at limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  console.log('org=' + ORG + ' user=' + UID);
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  await show('INSERT full customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Repro Co',null,'9999000011','r@e.com',null,'12 Test St',null,'Chennai','TN','600001','India','33',null) returning id, name, city, pincode`);
  await show('UPDATE existing customer', `
    update public.customers set name=name||' [edit]', phone='9999000099', email='e@e.com', city='Chennai', pincode='600002'
    where organization_id='${ORG}' and id in (select id from public.customers where organization_id='${ORG}' limit 1)
    returning id, name, phone, email, city, pincode`);
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
