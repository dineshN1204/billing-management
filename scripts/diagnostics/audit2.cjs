const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  // All trigger functions and whether they are SECURITY DEFINER and call auth.*
  const trg = await c.query(`
    select distinct t.tgname, c.relname tbl, p.proname, p.prosecdef
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and not t.tgisinternal
    order by c.relname, t.tgname`);
  console.log('=== TRIGGER FUNCTIONS ===');
  for (const t of trg.rows) {
    const d = (await c.query(`select pg_get_functiondef($1::oid) dd`, [t.tgfoid])).rows[0].dd;
    const usesAuth = /auth\.\s*(uid|jwt|role|user_id|organization|organization_id)\s*\(/i.test(d);
    const bad = usesAuth && !t.prosecdef;
    console.log(`${bad ? '*** BROKEN ***' : '  ok       '} ${t.tbl}.${t.tgname} -> ${t.proname}  secdef=${t.prosecdef} usesAuth=${usesAuth}`);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
