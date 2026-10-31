const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const r = await c.query(`
    select p.proname,
           p.prosecdef::text   as secdef,
           p.prosecdef          as secdef_raw,
           p.proacl::text       as acl,
           array_to_string(p.proacl, ' | ') as acl_arr
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private'
      and p.proname in ('is_org_member','can_write','is_org_admin','has_org_role','write_audit_row','bill_json','upsert_bill','set_updated_at','enforce_immutable_columns','guard_soft_delete')
    order by p.proname`);
  r.rows.forEach(x => console.log(`${x.proname.padEnd(26)} secdef=${x.secdef.padEnd(5)} raw=${JSON.stringify(x.secdef_raw)} acl=${x.acl_arr ?? '(DEFAULT)'}`));

  console.log('\n=== grants on app_private to authenticated (from aclarray) ===');
  const g = await c.query(`
    select p.proname, unnest(coalesce(p.proacl, array[]::aclitem[]))::text acl_entry
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app_private' and p.proname='is_org_member'`);
  g.rows.forEach(x => console.log(JSON.stringify(x)));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
