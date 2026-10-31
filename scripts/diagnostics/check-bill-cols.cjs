const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/^DATABASE_URL="(.+)"$/m)[1];
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const b = await c.query(`select column_name, data_type, is_generated from information_schema.columns where table_name='bills' and column_name in ('customer_phone','customer_email','customer_address') order by column_name`);
  console.log('bills customer_* cols:', b.rows.length ? JSON.stringify(b.rows) : 'NONE');
  const cc = await c.query(`select column_name, is_generated from information_schema.columns where table_name='customers' and column_name in ('phone','email','address','address_line_1','address_line_2','city','state','pincode','country') order by column_name`);
  console.log('customers contact cols:', JSON.stringify(cc.rows));
  await c.end();
})().catch(e => { console.error('FATAL', e.code, e.message); c.end(); process.exit(1); });
