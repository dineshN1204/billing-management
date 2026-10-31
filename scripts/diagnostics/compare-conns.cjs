const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const unpooled = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const pooled = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const show = async (cl, l, sql, p) => {
  try { const r = await cl.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};

async function run(label, connStr) {
  console.log('\n#################### ' + label + ' ####################');
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await show(c, 'secdef status of trigger funcs', `
    select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname in ('set_updated_at','enforce_immutable_columns','guard_soft_delete','normalize_customer_fields','write_audit_row')
    order by p.proname`);
  await show(c, 'auth schema acl', `select nspacl::text acl from pg_namespace where nspname='auth'`);
  await show(c, 'authenticated has USAGE on auth', `select has_schema_privilege('authenticated','auth','USAGE') u`);

  const org = await c.query(`
    select o.id, m.user_id from public.organizations o join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  const cust = await c.query(`select id, name from public.customers where organization_id='${ORG}' limit 1`);
  const CID = cust.rows[0].id;

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  await show(c, 'UPDATE customer', `update public.customers set name = name || '.' where id='${CID}' returning id, name`);
  await c.query('rollback');
  await c.end();
}
(async () => {
  await run('UNPOOLED', unpooled);
  await run('POOLED', pooled);
})().catch(e => { console.error('FATAL', e.code, e.message); process.exit(1); });
