const express = require("express");
const router  = express.Router();
let bugs      = require("../data/bugs.json");

// GET /api/bugs
router.get("/", (_req, res) => res.json(bugs));

// POST /api/bugs
router.post("/", (req, res) => {
  const { title, severity, description } = req.body;
  if (!title) return res.status(400).json({ error: "Title is required" });

  const newBug = {
    id: `BUG-${Math.floor(100 + Math.random() * 900)}`,
    title,
    severity: severity || "Medium",
    status: "Open",
    reportedDate: "Today",
    reporter: "Vendor Support",
    description: description || ""
  };
  bugs.unshift(newBug);
  res.status(201).json(newBug);
});

module.exports = router;
