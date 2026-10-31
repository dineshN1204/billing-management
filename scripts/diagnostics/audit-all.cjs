const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select n.nspname, p.proname, p.prosecdef,
           (p.prosrc ~* 'auth\\.\\s*(uid|jwt|role|user_id|organization|organization_id)\\s*\\(') uses_auth,
           pg_get_userbyid(p.proowner) owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('app_private','public')
    order by n.nspname, p.proname`);
  console.log('=== ALL functions using auth.* and their secdef status ===');
  let broken = 0;
  for (const x of r.rows) {
    if (x.uses_auth) {
      const bad = !x.prosecdef;
      if (bad) broken++;
      console.log(`${bad ? '*** BROKEN (not secdef) ***' : 'ok (secdef)          '} ${x.nspname}.${x.proname} owner=${x.owner}`);
    }
  }
  console.log('\nBroken count:', broken);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
