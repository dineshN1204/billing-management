const { Client } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/^DATABASE_URL="(.+)"$/m);
const c = new Client({ connectionString: m[1], ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  for (const t of ['customers', 'bills']) {
    const r = await c.query("select column_name, is_generated from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position", [t]);
    console.log('=== ' + t + ' (' + r.rows.length + ' cols) ===');
    console.log(r.rows.map(x => x.column_name + (x.is_generated === 'ALWAYS' ? '[gen]' : '')).join(', '));
  }
  const v = await c.query("select column_name from information_schema.columns where table_schema='public' and table_name='customers' and column_name in ('address_line_1','address_line_2','city','state','pincode','country','verification_status','verified_by','verified_at','customer_name')");
  console.log('0007 cols in customers: ' + (v.rows.map(x => x.column_name).join(', ') || 'NONE'));
  const b = await c.query("select column_name from information_schema.columns where table_schema='public' and table_name='bills' and column_name in ('customer_phone','customer_email','customer_address')");
  console.log('customer_* cols in bills: ' + (b.rows.map(x => x.column_name).join(', ') || 'NONE'));
  await c.end();
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
