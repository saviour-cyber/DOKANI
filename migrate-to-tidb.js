require("dotenv").config();
const { DatabaseSync } = require("node:sqlite");
const mysql = require("mysql2/promise");
const path = require("path");

async function migrate() {
  console.log("=========================================================");
  console.log("  DOKANI — SQLITE TO TIDB CLOUD DATA MIGRATION");
  console.log("=========================================================\n");

  // 1. Connect to SQLite
  const sqliteDbPath = path.join(__dirname, "dokani.db");
  console.log(`[1/4] Connecting to local SQLite (${sqliteDbPath})...`);
  const sqlite = new DatabaseSync(sqliteDbPath);
  console.log("  ✓ Local SQLite connected.\n");

  // 2. Connect to TiDB Cloud
  console.log(`[2/4] Connecting to TiDB Cloud (${process.env.TIDB_HOST}:4000)...`);
  const tidb = await mysql.createConnection({
    host: process.env.TIDB_HOST,
    port: parseInt(process.env.TIDB_PORT || "4000"),
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE || "dokani",
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true }
  });
  console.log("  ✓ TiDB Cloud connected.\n");

  // 3. Create Schema on TiDB Cloud
  console.log("[3/4] Creating tables on TiDB Cloud...");
  await tidb.query("SET FOREIGN_KEY_CHECKS = 0;");

  const tableDDLs = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'Admin',
      avatar VARCHAR(500),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS categories (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) UNIQUE NOT NULL,
      description TEXT,
      image VARCHAR(500),
      icon VARCHAR(100),
      is_active TINYINT(1) DEFAULT 1,
      display_order INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255),
      description TEXT,
      category_id VARCHAR(100),
      category_name VARCHAR(255),
      sku VARCHAR(100) UNIQUE NOT NULL,
      price DECIMAL(12,2) NOT NULL,
      sale_price DECIMAL(12,2),
      stock INT NOT NULL DEFAULT 0,
      low_stock_threshold INT DEFAULT 5,
      is_featured TINYINT(1) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Published',
      image VARCHAR(500),
      sales INT DEFAULT 0,
      rating DECIMAL(3,1) DEFAULT 5.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_category (category_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS inventory_movements (
      id VARCHAR(100) PRIMARY KEY,
      product_id VARCHAR(100) NOT NULL,
      change_type VARCHAR(50) NOT NULL,
      quantity INT NOT NULL,
      previous_stock INT NOT NULL,
      new_stock INT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50) NOT NULL,
      address TEXT,
      total_spent DECIMAL(12,2) DEFAULT 0,
      orders_count INT DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone (phone),
      INDEX idx_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS customer_accounts (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(50) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_verified TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      last_login DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer (customer_id),
      INDEX idx_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100),
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50) NOT NULL,
      delivery_address TEXT,
      fulfillment_type VARCHAR(50) DEFAULT 'Delivery',
      payment_method VARCHAR(50) DEFAULT 'M-Pesa',
      payment_status VARCHAR(50) DEFAULT 'Pending',
      order_status VARCHAR(50) DEFAULT 'Pending',
      subtotal DECIMAL(12,2) NOT NULL,
      discount_amount DECIMAL(12,2) DEFAULT 0,
      delivery_fee DECIMAL(12,2) DEFAULT 0,
      total DECIMAL(12,2) NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer (customer_id),
      INDEX idx_status (order_status),
      INDEX idx_payment_status (payment_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS order_items (
      id VARCHAR(100) PRIMARY KEY,
      order_id VARCHAR(100) NOT NULL,
      product_id VARCHAR(100) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      product_image VARCHAR(500),
      price DECIMAL(12,2) NOT NULL,
      quantity INT NOT NULL,
      total DECIMAL(12,2) NOT NULL,
      INDEX idx_order (order_id),
      INDEX idx_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS payments (
      id VARCHAR(100) PRIMARY KEY,
      order_id VARCHAR(100) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      method VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      transaction_ref VARCHAR(100),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      payment_method VARCHAR(50) DEFAULT 'mpesa_stk',
      provider VARCHAR(50) DEFAULT 'mpesa',
      phone_number VARCHAR(50),
      currency VARCHAR(10) DEFAULT 'KES',
      merchant_request_id VARCHAR(100),
      checkout_request_id VARCHAR(100),
      mpesa_receipt_number VARCHAR(100),
      transaction_date VARCHAR(50),
      result_code INT,
      result_description TEXT,
      raw_callback TEXT,
      callback_received_at DATETIME,
      updated_at DATETIME,
      INDEX idx_order (order_id),
      INDEX idx_checkout (checkout_request_id),
      INDEX idx_receipt (mpesa_receipt_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS promotions (
      id VARCHAR(100) PRIMARY KEY,
      code VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      discount_type VARCHAR(50) NOT NULL,
      discount_value DECIMAL(12,2) NOT NULL,
      min_spend DECIMAL(12,2) DEFAULT 0,
      valid_until DATE,
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS returns (
      id VARCHAR(100) PRIMARY KEY,
      order_id VARCHAR(100) NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      reason TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'Requested',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS reviews (
      id VARCHAR(100) PRIMARY KEY,
      product_id VARCHAR(100) NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      rating DECIMAL(3,1) NOT NULL,
      comment TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'Approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(100) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) DEFAULT 'order',
      is_read TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS wishlists (
      id VARCHAR(100) PRIMARY KEY,
      customer_account_id VARCHAR(100) NOT NULL,
      product_id VARCHAR(100) NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_customer_product (customer_account_id, product_id),
      INDEX idx_account (customer_account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS payment_settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      environment VARCHAR(50) DEFAULT 'sandbox',
      consumer_key VARCHAR(255),
      consumer_secret_encrypted TEXT,
      passkey_encrypted TEXT,
      shortcode VARCHAR(50) DEFAULT '174379',
      account_type VARCHAR(50) DEFAULT 'PayBill',
      callback_url VARCHAR(500),
      is_enabled TINYINT(1) DEFAULT 1,
      last_tested_at DATETIME,
      last_test_status VARCHAR(255),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS payment_audit_logs (
      id VARCHAR(100) PRIMARY KEY,
      admin_id VARCHAR(100),
      admin_name VARCHAR(255),
      action VARCHAR(100) NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  ];

  for (const ddl of tableDDLs) {
    await tidb.query(ddl);
  }
  console.log("  ✓ All 17 tables created/verified on TiDB Cloud.\n");

  // 4. Migrate Data Table by Table
  console.log("[4/4] Migrating data from SQLite to TiDB Cloud...");
  const tableNames = [
    "users",
    "categories",
    "products",
    "inventory_movements",
    "customers",
    "customer_accounts",
    "orders",
    "order_items",
    "payments",
    "promotions",
    "returns",
    "reviews",
    "notifications",
    "settings",
    "wishlists",
    "payment_settings",
    "payment_audit_logs"
  ];

  const migrationSummary = [];

  for (const tableName of tableNames) {
    const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all();
    
    // Clear destination table first to ensure idempotent migration
    await tidb.query(`DELETE FROM \`${tableName}\``);

    if (rows.length > 0) {
      const columns = Object.keys(rows[0]);
      const colList = columns.map(c => `\`${c}\``).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const insertSql = `INSERT INTO \`${tableName}\` (${colList}) VALUES (${placeholders})`;

      for (const row of rows) {
        const values = columns.map(col => {
          let val = row[col];
          // Normalize ISO dates if needed
          if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
            val = val.replace("T", " ").replace(/\.\d+Z?$/, "");
          }
          return val === undefined ? null : val;
        });
        await tidb.query(insertSql, values);
      }
    }

    const [countResult] = await tidb.query(`SELECT COUNT(*) as c FROM \`${tableName}\``);
    const tidbCount = countResult[0].c;

    migrationSummary.push({
      table: tableName,
      sqlite: rows.length,
      tidb: tidbCount,
      match: rows.length === tidbCount ? "✓" : "MISMATCH"
    });
    console.log(`  - ${tableName.padEnd(20)} SQLite: ${String(rows.length).padStart(3)} | TiDB: ${String(tidbCount).padStart(3)} ${rows.length === tidbCount ? "✓" : "❌"}`);
  }

  await tidb.query("SET FOREIGN_KEY_CHECKS = 1;");
  await tidb.end();

  console.log("\n=========================================================");
  console.log("  MIGRATION COMPLETE — ALL TABLES SYNCHRONIZED TO TIDB CLOUD!");
  console.log("=========================================================\n");
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
