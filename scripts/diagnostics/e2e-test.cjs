const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  await c.connect();
  const org = await c.query(`
    select o.id, m.user_id, m.role from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  console.log('using org', ORG, 'user', UID, 'role', org.rows[0].role);

  const asAuth = async () => {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
    await c.query(`set local role authenticated`);
  };
  const roll = async () => { try { await c.query('rollback') } catch (e) { console.log('rollback:', e.message) } };

  console.log('\n--- INSERT (new customer) ---');
  await asAuth();
  let cid = null;
  try {
    const ins = await c.query(`
      insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
      values ('${ORG}','Probe Co',null,'9999000011','p@e.com',null,'12 Test St',null,'Chennai','Tamil Nadu','600001','India','33',null) returning id, name`);
    cid = ins.rows[0].id;
    console.log('INSERT OK ->', JSON.stringify(ins.rows[0]));
  } catch (e) { console.log('INSERT FAIL ->', e.code, '|', e.message, e.detail ? '| ' + e.detail : '') }
  await roll();

  console.log('\n--- UPDATE the just-created customer ---');
  if (cid) {
    await asAuth();
    try {
      const upd = await c.query(`
        update public.customers set name=name||' (edited)', phone='9999000099', email='edit@example.com',
          address_line_1='9 New Road', city='Chennai', state='Tamil Nadu', pincode='600002', country='India'
        where id='${cid}' returning id, name, phone, email, city, pincode`);
      console.log('UPDATE OK ->', JSON.stringify(upd.rows[0]));
    } catch (e) { console.log('UPDATE FAIL ->', e.code, '|', e.message, e.detail ? '| ' + e.detail : '') }
    await roll();
  }

  console.log('\n--- UPDATE a pre-existing customer row ---');
  const pre = await c.query(`select id, name from public.customers where organization_id='${ORG}' and deleted_at is null limit 1`);
  if (pre.rowCount) {
    await asAuth();
    try {
      const upd = await c.query(`
        update public.customers set name=name||' (edited2)', phone='9999000098', email='edit2@example.com'
        where id='${pre.rows[0].id}' returning id, name, phone, email`);
      console.log('UPDATE pre-existing OK ->', JSON.stringify(upd.rows[0]));
    } catch (e) { console.log('UPDATE pre-existing FAIL ->', e.code, '|', e.message, e.detail ? '| ' + e.detail : '') }
    await roll();
  } else console.log('no pre-existing customer');

  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
