const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

router.get("/", async (_req, res) => {
  try {
    const rows = await db.prepare("SELECT key, value FROM settings").all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.post("/", requireAdminAuthApi, async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== "object") return res.status(400).json({ error: "Invalid settings object" });
  try {
    for (const [key, value] of Object.entries(updates)) {
      await db.prepare("INSERT OR REPLACE INTO settings (`key`, value) VALUES (?, ?)").run(key, String(value));
    }
    res.json({ message: "Settings saved successfully" });
  } catch (err) {
    console.error("Save settings error:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

module.exports = router;
