require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: parseInt(process.env.TIDB_PORT),
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: 'dokani',
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10
});

function normalizeSql(sql) {
  return sql
    .replace(/date\s*\(\s*['"]now['"]\s*\)/gi, 'CURDATE()')
    .replace(/datetime\s*\(\s*['"]now['"]\s*\)/gi, 'NOW()');
}

const db = {
  prepare(sql) {
    const s = normalizeSql(sql);
    return {
      async all(...params) {
        const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [rows] = await pool.query(s, p);
        return rows;
      },
      async get(...params) {
        const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [rows] = await pool.query(s, p);
        return rows[0] || null;
      },
      async run(...params) {
        const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [res] = await pool.execute(s, p);
        return { changes: res.affectedRows, lastInsertRowid: res.insertId };
      }
    };
  }
};

async function test() {
  const cats = await db.prepare('SELECT * FROM categories').all();
  console.log('Categories from TiDB:', cats.length);
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get('admin@dokani.co.ke');
  console.log('User found in TiDB:', user?.email, user?.name);
  await pool.end();
}

test().catch(console.error);
