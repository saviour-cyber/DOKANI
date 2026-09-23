const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");
const { encrypt, maskSecret } = require("../services/crypto");
const MpesaService = require("../services/mpesa");

// All admin payment routes require admin authentication
router.use(requireAdminAuthApi);

/**
 * GET /api/admin/payments/stats
 * Payment dashboard statistics (Section 19)
 */
router.get("/payments/stats", async (_req, res) => {
  try {
    // 1. Today's M-Pesa Sales
    const todaySalesRow = await db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments
      WHERE provider = 'mpesa' AND status = 'paid'
        AND date(created_at) = date('now')
    `).get();

    // 2. Pending M-Pesa Payments
    const pendingCountRow = await db.prepare(`
      SELECT count(*) as count
      FROM payments
      WHERE provider = 'mpesa' AND status = 'pending'
    `).get();

    // 3. Successful Transactions
    const successCountRow = await db.prepare(`
      SELECT count(*) as count
      FROM payments
      WHERE provider = 'mpesa' AND status = 'paid'
    `).get();

    // 4. Failed Transactions
    const failedCountRow = await db.prepare(`
      SELECT count(*) as count
      FROM payments
      WHERE provider = 'mpesa' AND status IN ('failed', 'cancelled', 'timeout')
    `).get();

    // 5. Total M-Pesa Revenue
    const totalRevenueRow = await db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payments
      WHERE provider = 'mpesa' AND status = 'paid'
    `).get();

    res.json({
      todaySales: todaySalesRow.total,
      pendingCount: pendingCountRow.count,
      successCount: successCountRow.count,
      failedCount: failedCountRow.count,
      totalRevenue: totalRevenueRow.total
    });
  } catch (err) {
    console.error("Payment stats error:", err);
    res.status(500).json({ error: "Failed to retrieve payment statistics." });
  }
});

/**
 * GET /api/admin/payments
 * List payment transactions with filters and search (Section 16)
 */
router.get("/payments", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const status = req.query.status;
    const search = req.query.search;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (status && status !== "All") {
      whereClause += " AND LOWER(p.status) = ?";
      params.push(status.toLowerCase());
    }

    if (search) {
      const q = `%${search.trim().toLowerCase()}%`;
      whereClause += ` AND (
        LOWER(p.id) LIKE ?
        OR LOWER(p.order_id) LIKE ?
        OR LOWER(COALESCE(p.mpesa_receipt_number, '')) LIKE ?
        OR LOWER(COALESCE(p.phone_number, '')) LIKE ?
        OR LOWER(COALESCE(o.customer_name, '')) LIKE ?
      )`;
      params.push(q, q, q, q, q);
    }

    const countRow = await db.prepare(`
      SELECT count(*) as total
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      ${whereClause}
    `).get(...params);

    const total = countRow.total;
    const offset = (page - 1) * limit;

    const payments = await db.prepare(`
      SELECT p.*,
             o.customer_name,
             o.customer_email,
             o.order_status,
             o.total as order_total
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: payments
    });
  } catch (err) {
    console.error("Admin payments list error:", err);
    res.status(500).json({ error: "Failed to load payment transactions." });
  }
});

/**
 * GET /api/admin/payments/:id
 * Single payment detail with raw callback, order info, and audit trail
 */
router.get("/payments/:id", async (req, res) => {
  try {
    const payment = await db.prepare(`
      SELECT p.*,
             o.customer_name,
             o.customer_phone as order_phone,
             o.customer_email,
             o.order_status,
             o.total as order_total,
             o.delivery_address,
             o.fulfillment_type
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: "Payment not found." });
    }

    // Parse raw callback if JSON
    let parsedCallback = null;
    if (payment.raw_callback) {
      try {
        parsedCallback = JSON.parse(payment.raw_callback);
      } catch (e) {
        parsedCallback = payment.raw_callback;
      }
    }

    // Associated audit logs
    const auditLogs = await db.prepare(`
      SELECT * FROM payment_audit_logs
      WHERE details LIKE ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(`%${payment.id}%`);

    res.json({
      ...payment,
      raw_callback_parsed: parsedCallback,
      audit_logs: auditLogs
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load payment detail." });
  }
});

/**
 * GET /api/admin/settings/payments/mpesa
 * Retrieve M-Pesa configuration with masked secrets (Section 3, 5, 6)
 */
router.get("/settings/payments/mpesa", async (_req, res) => {
  try {
    const conf = await db.prepare("SELECT * FROM payment_settings WHERE key = 'mpesa'").get();
    if (!conf) {
      return res.json({
        environment: "sandbox",
        shortcode: "174379",
        account_type: "PayBill",
        callback_url: "https://dokani.co.ke/api/payments/mpesa/callback",
        consumer_key: "",
        consumer_secret_masked: "",
        passkey_masked: "",
        has_consumer_secret: false,
        has_passkey: false,
        is_enabled: true,
        status: "Not Configured"
      });
    }

    const hasSecret = Boolean(conf.consumer_secret_encrypted);
    const hasPasskey = Boolean(conf.passkey_encrypted);

    let status = conf.last_test_status || "Not Configured";
    if (!conf.consumer_key || !hasSecret) {
      status = "Not Configured";
    }

    res.json({
      environment: conf.environment || "sandbox",
      shortcode: conf.shortcode || "174379",
      account_type: conf.account_type || "PayBill",
      callback_url: conf.callback_url || "",
      consumer_key: conf.consumer_key || "",
      consumer_secret_masked: hasSecret ? "••••••••••••••••" : "",
      passkey_masked: hasPasskey ? "••••••••••••••••" : "",
      has_consumer_secret: hasSecret,
      has_passkey: hasPasskey,
      is_enabled: Boolean(conf.is_enabled),
      last_tested_at: conf.last_tested_at,
      status
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load M-Pesa settings." });
  }
});

/**
 * PUT /api/admin/settings/payments/mpesa
 * Update M-Pesa configuration with encrypted secrets (Section 3, 4, 5)
 */
router.put("/settings/payments/mpesa", async (req, res) => {
  try {
    const {
      environment,
      shortcode,
      account_type,
      callback_url,
      consumer_key,
      consumer_secret,
      passkey,
      is_enabled
    } = req.body;

    const existing = await db.prepare("SELECT * FROM payment_settings WHERE key = 'mpesa'").get();

    const envToSave = environment === "production" ? "production" : "sandbox";
    const shortcodeToSave = (shortcode || "174379").trim();
    const accountTypeToSave = account_type === "Till" ? "Till" : "PayBill";
    const callbackToSave = (callback_url || "").trim();
    const consumerKeyToSave = consumer_key !== undefined ? consumer_key.trim() : (existing?.consumer_key || "");
    const enabledToSave = is_enabled !== undefined ? (is_enabled ? 1 : 0) : (existing?.is_enabled ?? 1);

    // Encrypt secrets if newly provided, otherwise retain existing
    let secretEncrypted = existing?.consumer_secret_encrypted || null;
    if (consumer_secret && consumer_secret.trim() && !consumer_secret.includes("••••")) {
      secretEncrypted = encrypt(consumer_secret.trim());
    }

    let passkeyEncrypted = existing?.passkey_encrypted || null;
    if (passkey && passkey.trim() && !passkey.includes("••••")) {
      passkeyEncrypted = encrypt(passkey.trim());
    }

    await db.prepare(`
      INSERT INTO payment_settings (
        \`key\`, environment, consumer_key, consumer_secret_encrypted,
        passkey_encrypted, shortcode, account_type, callback_url,
        is_enabled, updated_at
      ) VALUES ('mpesa', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        environment = VALUES(environment),
        consumer_key = VALUES(consumer_key),
        consumer_secret_encrypted = COALESCE(VALUES(consumer_secret_encrypted), payment_settings.consumer_secret_encrypted),
        passkey_encrypted = COALESCE(VALUES(passkey_encrypted), payment_settings.passkey_encrypted),
        shortcode = VALUES(shortcode),
        account_type = VALUES(account_type),
        callback_url = VALUES(callback_url),
        is_enabled = VALUES(is_enabled),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      envToSave,
      consumerKeyToSave,
      secretEncrypted,
      passkeyEncrypted,
      shortcodeToSave,
      accountTypeToSave,
      callbackToSave,
      enabledToSave
    );

    // Audit log (Section 24)
    const adminUser = req.user?.name || "Admin";
    await db.prepare(`
      INSERT INTO payment_audit_logs (id, admin_id, admin_name, action, details)
      VALUES (?, ?, ?, 'Updated M-Pesa Configuration', ?)
    `).run(
      `log_${Date.now()}`,
      req.user?.id || "usr_admin",
      adminUser,
      `Environment: ${envToSave}, Shortcode: ${shortcodeToSave}, AccountType: ${accountTypeToSave}`
    );

    res.json({
      success: true,
      message: "M-Pesa configuration saved successfully."
    });
  } catch (err) {
    console.error("Save M-Pesa settings error:", err);
    res.status(500).json({ error: "Failed to save M-Pesa configuration." });
  }
});

/**
 * POST /api/admin/settings/payments/mpesa/test
 * Validate configuration & test OAuth connection to Safaricom Daraja (Section 20)
 */
router.post("/settings/payments/mpesa/test", async (req, res) => {
  try {
    const adminUser = req.user?.name || "Admin";

    const result = await MpesaService.testConnection();

    // Record audit log
    await db.prepare(`
      INSERT INTO payment_audit_logs (id, admin_id, admin_name, action, details)
      VALUES (?, ?, ?, 'Test M-Pesa Connection', ?)
    `).run(
      `log_${Date.now()}`,
      req.user?.id || "usr_admin",
      adminUser,
      result.success ? "Connection Test: Success" : `Connection Test Failed: ${result.error}`
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Failed to test connection." });
  }
});

module.exports = router;
