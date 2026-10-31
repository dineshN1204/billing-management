const { Client } =require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const ORG = '13aacd4b-09a0-42f1-8f94-935cf0d794d4';
const UID = '64ca13ed-cf5c-4cdb-a4ea-a550dde08577';
(async () => {
  await c.connect();
  const tryGrant = async (sql) => {
    try { await c.query(sql); return 'RAN'; }
    catch (e) { return 'ERR ' + e.code + ' ' + e.message; }
  };
  const report = async () => {
    const acl = (await c.query(`select coalesce(nspacl::text,'(null)') acl from pg_namespace where nspname='auth'`)).rows[0].acl;
    const usage = (await c.query(`select has_schema_privilege('authenticated','auth','USAGE') u`)).rows[0].u;
    return `acl=${acl} authenticated_usage=${usage}`;
  };
  console.log('BEFORE:', await report());
  console.log('grant to authenticated:', await tryGrant(`grant usage on schema auth to authenticated`));
  console.log('  after:', await report());
  console.log('grant to public:', await tryGrant(`grant usage on schema auth to public`));
  console.log('  after:', await report());
  console.log('grant to anon,authenticated:', await tryGrant(`grant usage on schema auth to anon, authenticated`));
  console.log('  after:', await report());

  console.log('\n### UPDATE as authenticated after grants ###');
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })]);
  await c.query(`set local role authenticated`);
  const cust = await c.query(`select id from public.customers where organization_id='${ORG}' limit 1`);
  if (cust.rowCount) {
    const id = cust.rows[0].id;
    try {
      const r = await c.query(`update public.customers set phone='9999000001', email='a@b.com', city='Chennai' where id='${id}' returning id, phone, email, city`);
      console.log('OK   update:', JSON.stringify(r.rows[0]));
    } catch (e) { console.log('FAIL update:', e.code, e.message); }
  }
  await c.query('rollback');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
