const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/returns (Admin)
router.get("/", requireAdminAuthApi, async (_req, res) => {
  try {
    const returns = await db.prepare("SELECT * FROM returns ORDER BY created_at DESC").all();
    res.json(returns);
  } catch (err) {
    res.status(500).json({ error: "Failed to load return requests" });
  }
});

// POST /api/returns (Customer or Admin create return request)
router.post("/", async (req, res) => {
  const { order_id, customer_name, product_name, reason } = req.body;
  if (!order_id || !customer_name || !reason) {
    return res.status(400).json({ error: "Order ID, customer name, and reason are required" });
  }

  const id = `RET-${Math.floor(100 + Math.random() * 900)}`;
  try {
    await db.prepare(`
      INSERT INTO returns (id, order_id, customer_name, product_name, reason, status)
      VALUES (?, ?, ?, ?, ?, 'Requested')
    `).run(id, order_id.trim(), customer_name.trim(), product_name || "General Item", reason.trim());

    res.status(201).json({ message: "Return request submitted", id });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit return request" });
  }
});

// PATCH /api/returns/:id/status (Admin update status)
router.patch("/:id/status", requireAdminAuthApi, async (req, res) => {
  const { status } = req.body;
  const valid = ["Requested", "Approved", "Rejected", "Received", "Refunded", "Completed"];
  if (!status || !valid.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(", ")}` });
  }

  try {
    await db.prepare("UPDATE returns SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json({ message: "Return status updated", status });
  } catch (err) {
    res.status(500).json({ error: "Failed to update return status" });
  }
});

module.exports = router;
