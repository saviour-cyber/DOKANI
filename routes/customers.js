const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/customers (Admin)
router.get("/", requireAdminAuthApi, async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT c.*,
        (SELECT count(*) FROM orders WHERE customer_id = c.id) as orders_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = c.id AND order_status != 'Cancelled') as total_spent,
        (SELECT created_at FROM orders WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1) as last_order_date
      FROM customers c
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      const q = `%${search.trim().toLowerCase()}%`;
      query += " AND (LOWER(c.name) LIKE ? OR LOWER(c.phone) LIKE ? OR LOWER(c.email) LIKE ?)";
      params.push(q, q, q);
    }

    query += " ORDER BY c.created_at DESC";
    const customers = await db.prepare(query).all(...params);
    res.json(customers);
  } catch (err) {
    console.error("Customers error:", err);
    res.status(500).json({ error: "Failed to load customers" });
  }
});

// GET /api/customers/:id/orders (Admin)
router.get("/:id/orders", requireAdminAuthApi, async (req, res) => {
  try {
    const orders = await db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC").all(req.params.id);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Failed to load customer orders" });
  }
});

// PATCH /api/customers/:id/status (Admin toggle Active/Disabled)
router.patch("/:id/status", requireAdminAuthApi, async (req, res) => {
  const { status } = req.body;
  if (!status || !["Active", "Disabled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    await db.prepare("UPDATE customers SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json({ message: "Customer status updated", status });
  } catch (err) {
    res.status(500).json({ error: "Failed to update customer status" });
  }
});

// POST /api/customers (Admin manually add customer)
router.post("/", requireAdminAuthApi, async (req, res) => {
  const { name, email, phone, address } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: "Customer Name and Phone are required" });
  }

  const id = `cust_${Date.now()}`;
  try {
    await db.prepare(`
      INSERT INTO customers (id, name, email, phone, address)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name.trim(), email ? email.trim() : null, phone.trim(), address ? address.trim() : null);

    const created = await db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: "Failed to create customer" });
  }
});

module.exports = router;
