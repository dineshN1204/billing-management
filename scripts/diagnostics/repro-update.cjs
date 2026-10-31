// Reproduce EXACTLY what Neon Data API does: SET LOCAL ROLE authenticated + claims,
// then a normal UPDATE. This is the code path the app hits on "Save changes".
const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const POOLED = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: POOLED, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
(async () => {
  await c.connect();
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);

  const ex = await c.query(`select id, name from public.customers where organization_id='${ORG}' and deleted_at is null limit 1`);
  const cid = ex.rows[0].id;
  console.log('editing customer', cid, ex.rows[0].name);

  await show('UPDATE single field (what the UI actually sends)', `
    update public.customers set name = $1 where id = $2 returning id, name`, [ex.rows[0].name + ' *', cid]);

  await show('UPDATE with RETURNING * (needs SELECT grant on all cols)', `
    update public.customers set phone = '9999000099' where id = $1 returning *`, [cid]);

  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
