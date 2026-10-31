const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const show = async (cl, l, sql) => {
  try { const r = await cl.query(sql); console.log('=== ' + l + ' ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const url = env.match(new RegExp('^' + key + '="(.+)"$', 'm'))[1];
    const cl = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await cl.connect();
    console.log('\n########## ' + key + ' ##########');
    await show(cl, 'auth schema acl', `select nspname, nspacl from pg_namespace where nspname='auth'`);
    await show(cl, 'authenticated CAN use auth?', `select has_schema_privilege('authenticated','auth','USAGE') usage_ok`);
    await show(cl, 'trigger funcs secdef flags', `
      select p.proname, p.prosecdef secdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app_private' and p.proname in ('guard_soft_delete','normalize_customer_fields','write_audit_row','is_org_member','can_write')
      order by p.proname`);
    await cl.end();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
