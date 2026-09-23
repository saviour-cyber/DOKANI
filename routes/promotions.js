const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// POST /api/promotions/validate (Public Storefront Validation)
router.post("/validate", async (req, res) => {
  const { code, subtotal } = req.body;
  if (!code) {
    return res.status(400).json({ error: "Promo code is required" });
  }

  const promo = await db.prepare("SELECT * FROM promotions WHERE UPPER(code) = UPPER(?) AND is_active = 1").get(code.trim());
  if (!promo) {
    return res.status(404).json({ valid: false, error: "Invalid or expired promo code" });
  }

  // Check validity date
  if (promo.valid_until && new Date(promo.valid_until) < new Date()) {
    return res.status(400).json({ valid: false, error: "This promo code has expired" });
  }

  const numSubtotal = parseFloat(subtotal) || 0;
  if (promo.min_spend && numSubtotal < promo.min_spend) {
    return res.status(400).json({
      valid: false,
      error: `Minimum spend of KSh ${promo.min_spend.toLocaleString()} required for this coupon`
    });
  }

  let discount = 0;
  if (promo.discount_type === "Percentage") {
    discount = Math.round((numSubtotal * promo.discount_value) / 100);
  } else {
    discount = Math.min(numSubtotal, promo.discount_value);
  }

  res.json({
    valid: true,
    code: promo.code,
    discount_type: promo.discount_type,
    discount_value: promo.discount_value,
    discount_amount: discount,
    description: promo.description
  });
});

// GET /api/promotions (Admin & Storefront list)
router.get("/", async (_req, res) => {
  try {
    const promos = await db.prepare("SELECT * FROM promotions ORDER BY created_at DESC").all();
    res.json(promos);
  } catch (err) {
    res.status(500).json({ error: "Failed to load promotions" });
  }
});

// POST /api/promotions (Admin)
router.post("/", requireAdminAuthApi, async (req, res) => {
  const { code, description, discount_type, discount_value, min_spend, valid_until } = req.body;
  if (!code || !discount_type || discount_value === undefined) {
    return res.status(400).json({ error: "Code, discount type, and discount value are required" });
  }

  const id = `promo_${Date.now()}`;
  try {
    await db.prepare(`
      INSERT INTO promotions (id, code, description, discount_type, discount_value, min_spend, valid_until, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id,
      code.trim().toUpperCase(),
      description || "",
      discount_type,
      parseFloat(discount_value) || 0,
      parseFloat(min_spend) || 0,
      valid_until || null
    );

    const created = await db.prepare("SELECT * FROM promotions WHERE id = ?").get(id);
    res.status(201).json(created);
  } catch (err) {
    console.error("Create promotion error:", err);
    res.status(500).json({ error: "Failed to create promotion. Ensure code is unique." });
  }
});

// DELETE /api/promotions/:id (Admin)
router.delete("/:id", requireAdminAuthApi, async (req, res) => {
  try {
    await db.prepare("DELETE FROM promotions WHERE id = ?").run(req.params.id);
    res.json({ message: "Promotion deleted successfully", id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete promotion" });
  }
});

module.exports = router;
