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
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);

  // FULLY QUALIFIED calls should work even without schema USAGE
  await show('public.auth.uid() fully-qualified', `select public.auth.uid() u`);
  await show('fully-qualified insert+update cycle', `
    with ins as (
      insert into public.customers (organization_id, name, phone) values ('${ORG}','A',null) returning id, name
    ), upd as (
      update public.customers set name = 'B' where id = (select id from ins) returning id, name
    )
    select * from upd`);
  await show('direct auth.uid() (schema-qualified resolution)', `select auth.uid() u`);
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
