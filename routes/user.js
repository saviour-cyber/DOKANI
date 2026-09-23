const express = require("express");
const router = express.Router();
const { db } = require("../db");

router.get("/", async (_req, res) => {
  const admin = await db.prepare("SELECT id, name, email, role, avatar FROM users WHERE role = 'Admin' LIMIT 1").get();
  res.json(admin || { id: "usr_admin", name: "Dokani Administrator", email: "admin@dokani.co.ke", role: "Admin", avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80" });
});

module.exports = router;
