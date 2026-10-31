const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.oid, p.proname, p.prosecdef::text secdef, pg_get_userbyid(p.proowner) owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('app_private','public') order by 2`);
  const authUsers = [];
  for (const f of r.rows) {
    const d = (await c.query(`select pg_get_functiondef($1::oid) d`, [f.oid])).rows[0].d;
    if (/auth\.\s*(uid|jwt|role|user_id|organization_id|organization)\s*\(/i.test(d)) {
      authUsers.push(f);
      console.log(`${f.secdef === true ? 'SECDEF  ' : '!!!NOT!!!'} ${f.proname}() owner=${f.owner}`);
    }
  }
  console.log('\nTotal funcs calling auth.*:', authUsers.length);
  console.log('MISSING secdef:', authUsers.filter(f => f.secdef !== true).map(f => f.proname).join(', ') || 'none');
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
