const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/categories (Public)
router.get("/", async (_req, res) => {
  try {
    const categories = await db.prepare(`
      SELECT c.*, count(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.status != 'Archived'
      GROUP BY c.id
      ORDER BY c.display_order ASC, c.name ASC
    `).all();
    res.json(categories);
  } catch (err) {
    console.error("Categories fetch error:", err);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

// POST /api/categories (Admin)
router.post("/", requireAdminAuthApi, async (req, res) => {
  const { name, icon, description, display_order, is_active } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Category name is required" });
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const id = `cat_${Date.now()}`;

  try {
    await db.prepare(`
      INSERT INTO categories (id, name, slug, icon, description, display_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name.trim(),
      slug,
      icon || "tag",
      description || "",
      parseInt(display_order, 10) || 0,
      is_active !== undefined ? (is_active ? 1 : 0) : 1
    );

    const newCat = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    res.status(201).json(newCat);
  } catch (err) {
    console.error("Category create error:", err);
    res.status(500).json({ error: "Failed to create category. Ensure name is unique." });
  }
});

// PUT /api/categories/:id (Admin)
router.put("/:id", requireAdminAuthApi, async (req, res) => {
  const { id } = req.params;
  const { name, icon, description, display_order, is_active } = req.body;

  try {
    const existing = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Category not found" });

    const newName = name ? name.trim() : existing.name;
    const newSlug = name ? newName.toLowerCase().replace(/[^a-z0-9]+/g, "-") : existing.slug;

    await db.prepare(`
      UPDATE categories
      SET name = ?, slug = ?, icon = ?, description = ?, display_order = ?, is_active = ?
      WHERE id = ?
    `).run(
      newName,
      newSlug,
      icon !== undefined ? icon : existing.icon,
      description !== undefined ? description : existing.description,
      display_order !== undefined ? parseInt(display_order, 10) : existing.display_order,
      is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
      id
    );

    // Update category_name in products table
    if (name) {
      await db.prepare("UPDATE products SET category_name = ? WHERE category_id = ?").run(newName, id);
    }

    const updated = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    res.json(updated);
  } catch (err) {
    console.error("Category update error:", err);
    res.status(500).json({ error: "Failed to update category" });
  }
});

// DELETE /api/categories/:id (Admin)
router.delete("/:id", requireAdminAuthApi, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Category not found" });

    await db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    res.json({ message: "Category deleted successfully", id });
  } catch (err) {
    console.error("Category delete error:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

module.exports = router;
