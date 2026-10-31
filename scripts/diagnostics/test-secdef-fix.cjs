// TEMPORARY validation: recreate the offending trigger functions as SECURITY DEFINER,
// then re-run the failing UPDATE as `authenticated` to prove this is the root cause.
const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('d:/billing-management/.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
// list of app_private trigger functions that are NOT security definer but reference auth.*
async function offenderFunctions() {
  const r = await c.query(`
    select p.proname, p.prosecdef, pg_get_functiondef(p.oid) def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private'`);
  const out = [];
  for (const x of r.rows) {
    const isTrigger = /RETURNS trigger/i.test(x.def);
    const usesAuth = /auth\.\s*(uid|role|jwt)\s*\(/i.test(x.def);
    if (isTrigger && usesAuth && !x.prosecdef) out.push(x.proname);
  }
  return out;
}

(async () => {
  await c.connect();
  console.log('connected');
  const offenders = await offenderFunctions();
  console.log('NON-security-definer trigger functions using auth.*:', JSON.stringify(offenders));

  // Show the current bodies so we can rebuild them verbatim, only adding SECURITY DEFINER
  for (const f of offenders) {
    const r = await c.query(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app_private' and p.proname=$1`, [f]);
    console.log('\n===== ' + f + ' =====\n' + r.rows[0].def);
  }
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
