const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi } = require("../middleware/auth");

router.get("/", requireAdminAuthApi, async (_req, res) => {
  try {
    const notifications = await db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50").all();
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: "Failed to load notifications" });
  }
});

router.patch("/read-all", requireAdminAuthApi, async (_req, res) => {
  try {
    await db.prepare("UPDATE notifications SET is_read = 1").run();
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update notifications" });
  }
});

router.delete("/:id", requireAdminAuthApi, async (req, res) => {
  try {
    await db.prepare("DELETE FROM notifications WHERE id = ?").run(req.params.id);
    res.json({ message: "Notification deleted", id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

module.exports = router;
