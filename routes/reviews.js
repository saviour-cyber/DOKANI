const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

// GET /api/reviews (Admin all, or public approved)
router.get("/", async (req, res) => {
  try {
    const { product_id, status } = req.query;
    let query = `
      SELECT r.*, p.name as product_name, p.image as product_image
      FROM reviews r
      LEFT JOIN products p ON p.id = r.product_id
      WHERE 1=1
    `;
    const params = [];

    if (product_id) {
      query += " AND r.product_id = ?";
      params.push(product_id);
    }

    if (status) {
      query += " AND r.status = ?";
      params.push(status);
    }

    query += " ORDER BY r.created_at DESC";
    const reviews = await db.prepare(query).all(...params);
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: "Failed to load reviews" });
  }
});

// POST /api/reviews (Customer submit review)
router.post("/", async (req, res) => {
  const { product_id, customer_name, rating, comment } = req.body;
  if (!product_id || !customer_name || rating === undefined || !comment) {
    return res.status(400).json({ error: "Product, customer name, rating, and comment are required" });
  }

  const id = `rev_${Date.now()}`;
  try {
    await db.prepare(`
      INSERT INTO reviews (id, product_id, customer_name, rating, comment, status)
      VALUES (?, ?, ?, ?, ?, 'Approved')
    `).run(id, product_id, customer_name.trim(), parseFloat(rating) || 5.0, comment.trim());

    res.status(201).json({ message: "Review submitted successfully", id });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// PATCH /api/reviews/:id/status (Admin approve/hide)
router.patch("/:id/status", requireAdminAuthApi, async (req, res) => {
  const { status } = req.body;
  if (!status || !["Approved", "Hidden", "Pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    await db.prepare("UPDATE reviews SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json({ message: "Review status updated", status });
  } catch (err) {
    res.status(500).json({ error: "Failed to update review status" });
  }
});

// DELETE /api/reviews/:id (Admin delete)
router.delete("/:id", requireAdminAuthApi, async (req, res) => {
  try {
    await db.prepare("DELETE FROM reviews WHERE id = ?").run(req.params.id);
    res.json({ message: "Review deleted successfully", id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete review" });
  }
});

module.exports = router;
