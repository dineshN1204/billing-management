const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.proname,
           p.prosecdef,
           (position('auth.' in p.prosrc) > 0) uses_auth,
           pg_get_userbyid(p.proowner) owner
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
    group by p.proname, p.prosecdef, p.prosrc, p.proowner
    order by p.proname`);
  console.log('proname | secdef | uses_auth | owner');
  for (const x of r.rows) {
    const broken = x.uses_auth && !x.prosecdef;
    console.log(`${broken ? '***' : '   '} ${x.proname} | secdef=${x.prosecdef} | usesAuth=${x.uses_auth} | ${x.owner}`);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
