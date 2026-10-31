const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.proname, p.prosecdef::text secdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' order by p.proname`);
  const hits = r.rows.filter(x => /auth\.\s*(uid|role|jwt)\s*\(/i.test(x.def));
  console.log('=== app_private functions that CALL auth.uid()/auth.role()/auth.jwt() ===');
  hits.forEach(x => console.log(`  ${x.proname}   secdef=${x.secdef}`));
  console.log('\ntotal app_private:', r.rowCount, ' hits:', hits.length);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
