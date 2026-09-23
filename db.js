require("dotenv").config();
const mysql = require("mysql2/promise");
const crypto = require("crypto");

// ─── TiDB Cloud Connection Pool ─────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: parseInt(process.env.TIDB_PORT || "4000"),
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE || "dokani",
  ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: "+00:00",
  dateStrings: false
});

// ─── SQL Compatibility Shim (SQLite → MySQL/TiDB) ───────────────────────────
// Rewrites SQLite-specific syntax to MySQL-compatible equivalents
function normalizeSql(sql) {
  return sql
    // SQLite date('now') → MySQL CURDATE()
    .replace(/\bdate\s*\(\s*'now'\s*\)/gi, "CURDATE()")
    // SQLite datetime('now') → MySQL NOW()
    .replace(/\bdatetime\s*\(\s*'now'\s*\)/gi, "NOW()")
    // SQLite strftime('%s', ...) elapsed time → MySQL TIMESTAMPDIFF
    .replace(
      /CAST\(\(strftime\('%s',\s*'now'\)\s*-\s*strftime\('%s',\s*(\w+\.?\w*)\)\)\s*AS\s*INTEGER\)/gi,
      "TIMESTAMPDIFF(SECOND, $1, NOW())"
    )
    // SQLite INSERT OR REPLACE → MySQL REPLACE
    .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, "REPLACE INTO")
    // SQLite INSERT OR IGNORE → MySQL INSERT IGNORE
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT IGNORE INTO")
    // SQLite COALESCE(x, y) is fine — MySQL supports it natively
    // Backtick `key` column and table names
    .replace(/\bFROM\s+settings\b/gi, "FROM `settings`")
    .replace(/\bJOIN\s+settings\b/gi, "JOIN `settings`")
    .replace(/\bINTO\s+settings\b/gi, "INTO `settings`")
    .replace(/\bUPDATE\s+settings\b/gi, "UPDATE `settings`")
    .replace(/\bFROM\s+payment_settings\b/gi, "FROM `payment_settings`")
    .replace(/\bINTO\s+payment_settings\b/gi, "INTO `payment_settings`")
    .replace(/\bUPDATE\s+payment_settings\b/gi, "UPDATE `payment_settings`")
    .replace(/\bWHERE\s+key\s*=/gi, "WHERE `key` =")
    .replace(/\bSELECT\s+key\s*,/gi, "SELECT `key`, ")
    .replace(/\bSELECT\s+key\s+FROM/gi, "SELECT `key` FROM")
    .replace(/\(\s*key\s*,/gi, "(`key`, ")
    .replace(/,\s*key\s*\)/gi, ", `key`)")
    // Convert SQLite ? placeholders → keep as ? (MySQL2 supports ? natively)
    ;
}

// ─── Async DB Interface (mimics node:sqlite .prepare().get()/.all()/.run()) ──
const db = {
  prepare(sql) {
    const normalizedSql = normalizeSql(sql);
    return {
      // Returns array of rows
      async all(...params) {
        const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [rows] = await pool.query(normalizedSql, flat);
        return rows;
      },
      // Returns first row or null
      async get(...params) {
        const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [rows] = await pool.query(normalizedSql, flat);
        return rows[0] || null;
      },
      // Executes INSERT/UPDATE/DELETE, returns { changes, lastInsertRowid }
      async run(...params) {
        const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const [result] = await pool.execute(normalizedSql, flat);
        return {
          changes: result.affectedRows,
          lastInsertRowid: result.insertId
        };
      }
    };
  },

  // Direct execute shorthand for one-off queries
  async execute(sql, params = []) {
    const [result] = await pool.execute(normalizeSql(sql), params);
    return result;
  },

  // Health check
  async ping() {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return true;
  }
};

// ─── Password Hashing (scrypt — NIST/OWASP approved) ────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  try {
    const keyBuffer = Buffer.from(key, "hex");
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch (err) {
    return false;
  }
}

// ─── Database initialization (ensure DB exists, not table creation — tables
//     are already created by migrate-to-tidb.js) ────────────────────────────
async function initDatabase() {
  try {
    const conn = await pool.getConnection();
    // Quick health check — verify `settings` table is accessible
    await conn.query("SELECT COUNT(*) FROM `settings`");
    conn.release();
    console.log("✓ TiDB Cloud (dokani) database connected and ready.");
  } catch (err) {
    console.error("✗ TiDB Cloud connection failed:", err.message);
    console.error("  Check your .env file and TiDB Cloud cluster status.");
    // Do not crash the process — let routes handle individual errors
  }
}

// Run init check on startup
initDatabase();

module.exports = {
  db,
  pool,
  hashPassword,
  verifyPassword
};
