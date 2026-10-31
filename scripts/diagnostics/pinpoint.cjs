const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  await c.connect();

  console.log('\n##### 1. Which trigger functions reference auth.* ? #####');
  const r = await c.query(`
    select n.nspname, p.proname, p.prosecdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('app_private','public') order by p.proname`);
  for (const x of r.rows) {
    const hits = x.def.split('\n').filter(l => /auth\s*\.\s*(uid|role|jwt)/i.test(l));
    if (hits.length) console.log(`>>> ${x.nspname}.${x.proname} secdef=${x.prosecdef}\n    ${hits.map(h=>h.trim()).join('\n    ')}`);
  }

  console.log('\n##### 2. normalize_customer_fields FULL def #####');
  const ncf = await c.query(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname='normalize_customer_fields'`);
  console.log(ncf.rows[0].def);

  console.log('\n##### 3. GRANT test with command tags #####');
  let res = await c.query(`grant usage on schema auth to authenticated`);
  console.log('grant usage schema -> tag:', JSON.stringify(res));
  res = await c.query(`grant execute on all functions in schema auth to authenticated`);
  console.log('grant exec funcs -> tag:', JSON.stringify(res));
  const acl = await c.query(`select nspacl from pg_namespace where nspname='auth'`);
  console.log('auth nspacl now:', acl.rows[0].nspacl);
  console.log('has_schema_privilege authenticated USAGE:', (await c.query(`select has_schema_privilege('authenticated','auth','USAGE') u`)).rows[0].u);

  await c.end();
})().catch(e => { console.error('FATAL', e.code, e.message); c.end().catch(()=>{}); process.exit(1); });
