const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const pooled = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const unpooled = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];

async function runAsAuth(cl, uid, fn) {
  await cl.query('begin');
  await cl.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await cl.query(`set local role authenticated`);
  try { const r = await fn(); return { ok: true, rows: r.rows } }
  catch (e) { return { ok: false, code: e.code, msg: e.message } }
  finally { await cl.query('rollback') }
}

const FULL = `update public.customers set name=name||' (edited)', phone='9999000099', email='edit@example.com',
  address_line_1='9 New Road', city='Chennai', state='Tamil Nadu', pincode='600002', country='India', gstin=null`;

(async () => {
for (const [label, url] of [['POOLED', pooled], ['UNPOOLED', unpooled]]) {
  console.log('\n################ ' + label + ' ################');
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  const cust = await c.query(`select id, name, verification_status, deleted_at from public.customers where organization_id='${ORG}' order by name limit 1`);
  console.log('customer:', JSON.stringify(cust.rows[0]));

  let r = await runAsAuth(c, UID, () => c.query(`update public.customers set name=name||' *' where id='${cust.rows[0].id}' returning id`));
  console.log('  minimal UPDATE  ->', r.ok ? 'OK' : `FAIL ${r.code} | ${r.msg}`);
  r = await runAsAuth(c, UID, () => c.query(`${FULL} where id='${cust.rows[0].id}' returning id`));
  console.log('  full-record UPD ->', r.ok ? 'OK' : `FAIL ${r.code} | ${r.msg}`);
  r = await runAsAuth(c, UID, () => c.query(`select auth.uid() u`));
  console.log('  auth.uid()      ->', r.ok ? 'OK ' + JSON.stringify(r.rows) : `FAIL ${r.code} | ${r.msg}`);
  await c.end();
}
})().then(() => process.exit(0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });

