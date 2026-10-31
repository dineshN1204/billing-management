const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, q) => { const r = await c.query(q); console.log('=== ' + l + ' ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) };
(async () => {
  await c.connect();
  await show('customers per org', `
    select organization_id, count(*) n,
           count(*) filter (where name like '%Probe%') probe_rows,
           count(*) filter (where name like '%edited%') edited_rows
    from public.customers group by organization_id`);
  await show('probe rows detail', `select id, organization_id, name, created_at from public.customers where name like '%Probe%' or name like '%edited%' order by created_at`);
  await show('bills per org', `select organization_id, count(*) n from public.bills group by organization_id`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
