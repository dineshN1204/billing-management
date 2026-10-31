const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function runAsAuth(uid, fn) {
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  try { const r = await fn(); return { ok: true, rows: r.rows } }
  catch (e) { return { ok: false, code: e.code, msg: e.message } }
  finally { await c.query('rollback') }
}

(async () => {
  await c.connect();
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  const cust = await c.query(`select id, name from public.customers where organization_id='${ORG}' limit 1`);
  const CID = cust.rows[0].id;
  console.log('org', ORG, 'user', UID, 'customer', CID);

  // list UPDATE triggers on customers
  const trg = await c.query(`
    select t.tgname, t.tgenabled from pg_trigger t
    where t.tgrelid='public.customers'::regclass and not t.tgisinternal
      and (t.tgtype & 8) > 0 order by t.tgname`);
  console.log('\nUPDATE-path triggers:', trg.rows.map(r => r.tgname).join(', '));

  console.log('\n--- baseline UPDATE (all triggers on) ---');
  let r = await runAsAuth(UID, () => c.query(`update public.customers set name=name||' *' where id='${CID}' returning id`));
  console.log(r.ok ? 'OK' : `FAIL ${r.code} | ${r.msg}`);

  console.log('\n--- bisect: disable each trigger one at a time ---');
  for (const t of trg.rows) {
    await c.query(`alter table public.customers disable trigger ${t.tgname}`);
    r = await runAsAuth(UID, () => c.query(`update public.customers set name=name||' *' where id='${CID}' returning id`));
    console.log(`  disable ${t.tgname.padEnd(24)} -> ${r.ok ? 'OK  (UPDATE WORKS)' : 'FAIL ' + r.code + ' | ' + r.msg}`);
    await c.query(`alter table public.customers enable trigger ${t.tgname}`);
  }

  console.log('\n--- confirm all triggers re-enabled ---');
  const chk = await c.query(`select t.tgname, t.tgenabled from pg_trigger t where t.tgrelid='public.customers'::regclass and not t.tgisinternal order by t.tgname`);
  chk.rows.forEach(x => console.log(`  ${x.tgname} enabled=${x.tgenabled}`));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
