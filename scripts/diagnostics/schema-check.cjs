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
  await show('bills columns', `
    select column_name, data_type, is_generated, generation_expression
    from information_schema.columns where table_name='bills' order by ordinal_position`);
  await show('customers columns', `
    select column_name, data_type from information_schema.columns where table_name='customers' order by ordinal_position`);
  await show('customer_* columns on bills', `
    select column_name from information_schema.columns
    where table_name='bills' and column_name like 'customer_%' order by ordinal_position`);
  await show('set_customer_verification def', `
    select pg_get_functiondef(p.oid) def from pg_proc p
    where p.proname='set_customer_verification'`);
  await c.end();
})().catch(e => { console.error('FATAL', e.message); c.end(); process.exit(1); });
