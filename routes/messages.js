const express = require("express");
const router  = express.Router();
let conversations = require("../data/messages.json");

// GET /api/messages
router.get("/", (_req, res) => res.json(conversations));

// POST /api/messages/:id/reply
router.post("/:id/reply", (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Message text is required" });

  const conv = conversations.find(c => c.id === id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const newMsg = { sender: "vendor", text, time: timeStr };

  conv.messages.push(newMsg);
  conv.lastMessage = text;
  conv.time = "Just now";
  conv.unread = false;

  res.json({ conversation: conv, message: newMsg });
});

module.exports = router;
