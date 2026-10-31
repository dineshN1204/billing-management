const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const show = async (l, sql, p) => {
  try { const r = await c.query(sql, p); console.log('=== ' + l + ' (' + r.rowCount + ') ==='); r.rows.forEach(x => console.log(JSON.stringify(x))) }
  catch (e) { console.log('=== ' + l + ' ERROR === ' + e.code + ' | ' + e.message) }
};
(async () => {
  await c.connect();
  await show('bills columns', `select column_name, data_type, is_generated, generation_expression
    from information_schema.columns where table_name='bills' order by ordinal_position`);
  await show('bills col privs', `select grantee, privilege_type from information_schema.column_privileges
    where table_name='bills' and grantee in ('authenticated','anonymous') order by grantee`);
  await show('customers col privs', `select column_name, string_agg(distinct privilege_type, ',') privs
    from information_schema.column_privileges where table_name='customers' and grantee='authenticated'
    and privilege_type in ('INSERT','UPDATE') group by column_name order by column_name`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
