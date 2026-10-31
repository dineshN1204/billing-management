const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const ORG = '13aacd4b-09a0-42f1-8f94-935cf0d794d4';
const UID = '64ca13ed-cf5c-4cdb-a4ea-a550dde08577';
(async () => {
  await c.connect();
  // create a SECURITY DEFINER helper owned by neondb_owner
  await c.query(`
    create or replace function app_private.current_uid()
    returns uuid language sql stable security definer set search_path = pg_catalog, public
    as $$ select auth.uid() $$;`);
  await c.query(`revoke all on function app_private.current_uid() from public;`);
  await c.query(`grant execute on function app_private.current_uid() to authenticated;`);

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  try {
    const r = await c.query(`select app_private.current_uid() u`);
    console.log('OK   current_uid() as authenticated ->', JSON.stringify(r.rows[0]));
  } catch (e) { console.log('FAIL current_uid():', e.code, e.message); }

  // now simulate guard_soft_delete calling current_uid() instead of auth.uid()
  const cust = await c.query(`select id from public.customers where organization_id='${ORG}' limit 1`);
  if (cust.rowCount) {
    const id = cust.rows[0].id;
    try {
      const r = await c.query(`update public.customers set phone='9999000001', city='Chennai' where id='${id}' returning id`);
      console.log('OK   plain update (still uses auth.uid() in guard):', JSON.stringify(r.rows[0]));
    } catch (e) { console.log('FAIL plain update:', e.code, e.message); }
  }
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
