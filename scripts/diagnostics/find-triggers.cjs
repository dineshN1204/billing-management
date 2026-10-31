const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  await c.connect();
  console.log('connected');
  const r = await c.query(`
    select p.proname, p.prosecdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private'`);
  for (const x of r.rows) {
    const isTrigger = /RETURNS trigger/i.test(x.def);
    const usesAuth = /auth\.\s*(uid|role|jwt)\s*\(/i.test(x.def);
    if (isTrigger && usesAuth) {
      console.log('TRIGGER+' + (x.prosecdef ? ' secdef' : ' !SECDEF') + ' -> ' + x.proname);
    }
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
