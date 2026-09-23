const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/reports/summary (Admin)
router.get("/summary", requireAdminAuthApi, async (_req, res) => {
  try {
    // Best selling products
    const bestSellers = await db.prepare(`
      SELECT p.id, p.name, p.sku, p.category_name, p.price, p.sales, (p.sales * p.price) as revenue, p.stock
      FROM products p
      ORDER BY p.sales DESC
      LIMIT 10
    `).all();

    // Low performing products
    const slowMovers = await db.prepare(`
      SELECT p.id, p.name, p.sku, p.category_name, p.price, p.sales, p.stock
      FROM products p
      WHERE p.status != 'Archived'
      ORDER BY p.sales ASC
      LIMIT 10
    `).all();

    // Top customers
    const topCustomers = await db.prepare(`
      SELECT id, name, phone, email, orders_count, total_spent
      FROM customers
      ORDER BY total_spent DESC
      LIMIT 10
    `).all();

    // Inventory report
    const inventoryValuation = await db.prepare(`
      SELECT
        category_name,
        count(*) as product_count,
        SUM(stock) as total_stock,
        SUM(stock * price) as category_value
      FROM products
      WHERE status != 'Archived'
      GROUP BY category_name
    `).all();

    res.json({
      bestSellers,
      slowMovers,
      topCustomers,
      inventoryValuation
    });
  } catch (err) {
    console.error("Reports error:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// GET /api/reports/export (CSV Download)
router.get("/export", requireAdminAuthApi, async (req, res) => {
  const type = req.query.type || "sales";

  try {
    let csv = "";
    let filename = `dokani_${type}_report_${Date.now()}.csv`;

    if (type === "sales" || type === "orders") {
      const orders = await db.prepare(`
        SELECT id, customer_name, customer_phone, fulfillment_type, payment_method, payment_status, order_status, subtotal, discount_amount, delivery_fee, total, created_at
        FROM orders
        ORDER BY created_at DESC
      `).all();

      csv = "Order ID,Customer Name,Phone,Fulfillment,Payment Method,Payment Status,Order Status,Subtotal (KSh),Discount (KSh),Delivery Fee (KSh),Total (KSh),Date\n";
      for (const o of orders) {
        csv += `"${o.id}","${o.customer_name}","${o.customer_phone}","${o.fulfillment_type}","${o.payment_method}","${o.payment_status}","${o.order_status}",${o.subtotal},${o.discount_amount},${o.delivery_fee},${o.total},"${o.created_at}"\n`;
      }
    } else if (type === "products") {
      const products = await db.prepare(`
        SELECT id, name, sku, category_name, price, stock, sales, (stock * price) as stock_value, status
        FROM products
        WHERE status != 'Archived'
        ORDER BY name ASC
      `).all();

      csv = "Product ID,Name,SKU,Category,Price (KSh),Stock,Sales,Stock Value (KSh),Status\n";
      for (const p of products) {
        csv += `"${p.id}","${p.name.replace(/"/g, '""')}","${p.sku}","${p.category_name}",${p.price},${p.stock},${p.sales},${p.stock_value},"${p.status}"\n`;
      }
    } else if (type === "customers") {
      const customers = await db.prepare("SELECT id, name, phone, email, orders_count, total_spent, status, created_at FROM customers ORDER BY total_spent DESC").all();
      csv = "Customer ID,Name,Phone,Email,Orders Count,Total Spent (KSh),Status,Created At\n";
      for (const c of customers) {
        csv += `"${c.id}","${c.name}","${c.phone}","${c.email || ''}",${c.orders_count},${c.total_spent},"${c.status}","${c.created_at}"\n`;
      }
    } else {
      // Inventory
      const inv = await db.prepare("SELECT id, name, sku, category_name, stock, low_stock_threshold, price, (stock * price) as valuation, status FROM products WHERE status != 'Archived'").all();
      csv = "Product ID,Product Name,SKU,Category,Stock On Hand,Low Stock Threshold,Unit Price (KSh),Total Valuation (KSh),Status\n";
      for (const i of inv) {
        csv += `"${i.id}","${i.name.replace(/"/g, '""')}","${i.sku}","${i.category_name}",${i.stock},${i.low_stock_threshold},${i.price},${i.valuation},"${i.status}"\n`;
      }
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).send("Error exporting CSV");
  }
});

module.exports = router;
