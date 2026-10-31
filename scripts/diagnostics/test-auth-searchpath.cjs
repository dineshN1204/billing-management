const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('OK    ' + l + ' -> ' + JSON.stringify(r.rows ?? [])) }
  catch (e) { console.log('FAIL  ' + l + ' -> ' + e.code + ' | ' + e.message + (e.detail ? ' | ' + e.detail : '')) }
};
(async () => {
  await c.connect();
  console.log('connected (unpooled)');

  // Pick the org that has data + its admin
  const org = await c.query(`
    select o.id, m.user_id from public.organizations o
    join public.memberships m on m.organization_id=o.id
    where (select count(*) from public.customers x where x.organization_id=o.id) > 0 limit 1`);
  const ORG = org.rows[0].id, UID = org.rows[0].user_id;
  console.log('org', ORG, 'user', UID);

  // Pin search_path so triggers can resolve auth.uid() without relying on caller's search_path
  await c.query(`grant usage on schema auth to authenticated`);
  await c.query(`grant execute on all functions in schema auth to authenticated`);

  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  await c.query(`select set_config('search_path', 'pg_catalog, public', true)`);
  await show('search_path', `select current_setting('search_path') sp`);
  await show('auth.uid()', `select auth.uid() uid`);
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
