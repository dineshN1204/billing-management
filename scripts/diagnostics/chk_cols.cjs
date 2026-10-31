const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL_UNPOOLED="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const cols = await c.query(`select column_name, data_type from information_schema.columns
    where table_name='bills' and column_name like 'customer%' order by ordinal_position`);
  console.log('bills.customer* columns:', cols.rows.map(r => r.column_name + ':' + r.data_type).join(', '));
  const cust = await c.query(`select column_name from information_schema.columns
    where table_name='customers' order by ordinal_position`);
  console.log('\ncustomers columns:', cust.rows.map(r => r.column_name).join(', '));
  await c.end();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
