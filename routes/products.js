const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/products (Public)
router.get("/", async (req, res) => {
  try {
    const { category, search, featured, status, storefront } = req.query;
    let query = "SELECT * FROM products WHERE 1=1";
    const params = [];

    if (storefront === "true") {
      query += " AND status = 'Published'";
    } else if (status && status !== "All") {
      query += " AND status = ?";
      params.push(status);
    } else {
      query += " AND status != 'Archived'";
    }

    if (category && category !== "All") {
      query += " AND (LOWER(category_name) = LOWER(?) OR category_id = ?)";
      params.push(category, category);
    }

    if (featured === "1" || featured === "true") {
      query += " AND is_featured = 1";
    }

    if (search) {
      const q = `%${search.trim().toLowerCase()}%`;
      query += " AND (LOWER(name) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(description) LIKE ?)";
      params.push(q, q, q);
    }

    query += " ORDER BY created_at DESC";

    const products = await db.prepare(query).all(...params);
    res.json(products);
  } catch (err) {
    console.error("Products query error:", err);
    res.status(500).json({ error: "Failed to load products" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "Failed to load product" });
  }
});

router.post("/", requireAdminAuthApi, async (req, res) => {
  const { name, category_id, price, sale_price, stock, low_stock_threshold, sku, is_featured, status, description, image } = req.body;

  if (!name || price === undefined || price === "") {
    return res.status(400).json({ error: "Product Name and Price are required" });
  }

  const prodId = `prod_${Date.now()}`;
  const genSku = sku ? sku.trim().toUpperCase() : `DK-${Math.floor(1000 + Math.random() * 9000)}`;
  const initialStock = parseInt(stock, 10) || 0;
  const numPrice = parseFloat(price) || 0;
  const numSalePrice = sale_price ? parseFloat(sale_price) : null;
  const lowThreshold = parseInt(low_stock_threshold, 10) || 5;

  let catName = "General";
  if (category_id) {
    const cat = await db.prepare("SELECT name FROM categories WHERE id = ?").get(category_id);
    if (cat) catName = cat.name;
  }

  const initialStatus = status || (initialStock > 0 ? "Published" : "Out of Stock");
  const defaultImg = image || "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&auto=format&fit=crop&q=80";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  try {
    await db.prepare(`
      INSERT INTO products (id, name, slug, description, category_id, category_name, sku, price, sale_price, stock, low_stock_threshold, is_featured, status, image, sales, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(prodId, name.trim(), slug, description || "", category_id || null, catName, genSku, numPrice, numSalePrice, initialStock, lowThreshold, is_featured ? 1 : 0, initialStatus, defaultImg, 0, 5.0);

    await db.prepare(`
      INSERT INTO inventory_movements (id, product_id, change_type, quantity, previous_stock, new_stock, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`inv_${Date.now()}`, prodId, "Adjustment", initialStock, 0, initialStock, "Product created");

    const created = await db.prepare("SELECT * FROM products WHERE id = ?").get(prodId);
    res.status(201).json(created);
  } catch (err) {
    console.error("Product create error:", err);
    res.status(500).json({ error: "Failed to create product. Check SKU uniqueness." });
  }
});

router.put("/:id", requireAdminAuthApi, async (req, res) => {
  const { id } = req.params;
  const { name, category_id, price, sale_price, stock, low_stock_threshold, sku, is_featured, status, description, image } = req.body;

  try {
    const existing = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Product not found" });

    let catName = existing.category_name;
    if (category_id && category_id !== existing.category_id) {
      const cat = await db.prepare("SELECT name FROM categories WHERE id = ?").get(category_id);
      if (cat) catName = cat.name;
    }

    const newStock = stock !== undefined ? parseInt(stock, 10) : existing.stock;
    if (newStock !== existing.stock) {
      const diff = newStock - existing.stock;
      await db.prepare(`
        INSERT INTO inventory_movements (id, product_id, change_type, quantity, previous_stock, new_stock, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`inv_${Date.now()}`, id, diff > 0 ? "Increase" : "Decrease", Math.abs(diff), existing.stock, newStock, "Stock updated in product edit");
    }

    const newName = name !== undefined ? name.trim() : existing.name;
    const newSlug = name ? newName.toLowerCase().replace(/[^a-z0-9]+/g, "-") : existing.slug;

    await db.prepare(`
      UPDATE products SET name = ?, slug = ?, description = ?, category_id = ?, category_name = ?, sku = ?, price = ?, sale_price = ?, stock = ?, low_stock_threshold = ?, is_featured = ?, status = ?, image = ? WHERE id = ?
    `).run(newName, newSlug, description !== undefined ? description : existing.description, category_id !== undefined ? category_id : existing.category_id, catName, sku !== undefined ? sku.trim().toUpperCase() : existing.sku, price !== undefined ? parseFloat(price) : existing.price, sale_price !== undefined ? (sale_price ? parseFloat(sale_price) : null) : existing.sale_price, newStock, low_stock_threshold !== undefined ? parseInt(low_stock_threshold, 10) : existing.low_stock_threshold, is_featured !== undefined ? (is_featured ? 1 : 0) : existing.is_featured, status !== undefined ? status : existing.status, image !== undefined && image ? image : existing.image, id);

    const updated = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    res.json(updated);
  } catch (err) {
    console.error("Product update error:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

router.delete("/:id", requireAdminAuthApi, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Product not found" });
    await db.prepare("UPDATE products SET status = 'Archived' WHERE id = ?").run(id);
    res.json({ message: "Product archived successfully", id });
  } catch (err) {
    console.error("Product delete error:", err);
    res.status(500).json({ error: "Failed to archive product" });
  }
});

module.exports = router;
