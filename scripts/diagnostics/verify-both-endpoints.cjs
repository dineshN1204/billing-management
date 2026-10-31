const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const UNPOOLED = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const POOLED = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const show = async (c, l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};

async function run(endpoint, label) {
  console.log('\n############ ' + label + ' ############');
  const c = new Client({ connectionString: endpoint, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await show(c, 'auth schema ACL', `select nspacl from pg_namespace where nspname='auth'`);
  await show(c, 'auth.uid() EXECUTE for authenticated', `select has_function_privilege('authenticated','auth.uid()','EXECUTE') x`);

  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  await show(c, 'direct auth.uid()', `select auth.uid() uid`);
  await show(c, 'is_org_member', `select app_private.is_org_member('${ORG}'::uuid) m`);
  await show(c, 'INSERT customer', `
    insert into public.customers (organization_id, name, gstin, phone, email, address, address_line_1, address_line_2, city, state, pincode, country, state_code, notes)
    values ('${ORG}','Probe Co',null,'9999000011','p@e.com',null,'12 Test St',null,'Chennai','Tamil Nadu','600001','India','33',null) returning id, name`);
  const ex = await c.query(`select id from public.customers where organization_id='${ORG}' and deleted_at is null limit 1`);
  await show(c, 'UPDATE customer', `
    update public.customers set name=name||' (e)', phone='9999000099', email='e@e.com', city='Madurai', pincode='600002'
    where id='${ex.rows[0].id}' returning id, name, phone, email, city`);
  await c.query('rollback');
  await c.end();
}
(async () => {
  await run(POOLED, 'POOLED (app / Data API uses this)');
  await run(UNPOOLED, 'UNPOOLED (direct)');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
