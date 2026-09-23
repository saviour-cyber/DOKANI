const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/inventory (Admin)
router.get("/", requireAdminAuthApi, async (_req, res) => {
  try {
    const products = await db.prepare(`
      SELECT
        id, name, sku, category_name, price, stock, low_stock_threshold,
        (stock * price) as stock_value,
        status, image
      FROM products
      WHERE status != 'Archived'
      ORDER BY stock ASC, name ASC
    `).all();

    const movements = await db.prepare(`
      SELECT m.*, p.name as product_name, p.sku as product_sku
      FROM inventory_movements m
      JOIN products p ON p.id = m.product_id
      ORDER BY m.created_at DESC
      LIMIT 30
    `).all();

    const summary = await db.prepare(`
      SELECT
        COALESCE(SUM(stock * price), 0) as totalStockValue,
        COALESCE(SUM(stock), 0) as totalUnits,
        SUM(CASE WHEN stock <= low_stock_threshold AND stock > 0 THEN 1 ELSE 0 END) as lowStockCount,
        SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END) as outOfStockCount
      FROM products
      WHERE status != 'Archived'
    `).get();

    res.json({
      summary,
      products,
      recentMovements: movements
    });
  } catch (err) {
    console.error("Inventory error:", err);
    res.status(500).json({ error: "Failed to load inventory" });
  }
});

// POST /api/inventory/adjust (Admin)
router.post("/adjust", requireAdminAuthApi, async (req, res) => {
  const { product_id, change_type, quantity, reason } = req.body;

  if (!product_id || !change_type || quantity === undefined) {
    return res.status(400).json({ error: "Product, change type, and quantity are required" });
  }

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: "Quantity must be a positive integer" });
  }

  try {
    const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(product_id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    let newStock = product.stock;
    if (change_type === "Increase") {
      newStock += qty;
    } else if (change_type === "Decrease") {
      newStock = Math.max(0, newStock - qty);
    } else if (change_type === "Set") {
      newStock = qty;
    } else {
      return res.status(400).json({ error: "Invalid change type. Use Increase, Decrease, or Set" });
    }

    const newStatus = newStock === 0 ? "Out of Stock" : (newStock <= product.low_stock_threshold ? "Low Stock" : "Published");

    // Update product stock
    await db.prepare("UPDATE products SET stock = ?, status = ? WHERE id = ?").run(newStock, newStatus, product_id);

    // Record movement
    const movementId = `inv_${Date.now()}`;
    await db.prepare(`
      INSERT INTO inventory_movements (id, product_id, change_type, quantity, previous_stock, new_stock, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId,
      product_id,
      change_type,
      qty,
      product.stock,
      newStock,
      reason || "Manual stock adjustment"
    );

    res.json({
      message: "Stock adjusted successfully",
      product_id,
      previous_stock: product.stock,
      new_stock: newStock,
      status: newStatus
    });
  } catch (err) {
    console.error("Inventory adjust error:", err);
    res.status(500).json({ error: "Failed to adjust stock" });
  }
});

module.exports = router;
