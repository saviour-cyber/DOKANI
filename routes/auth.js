const express = require("express");
const router = express.Router();
const { db, verifyPassword, hashPassword } = require("../db");
const {
  COOKIE_NAME,
  generateAdminToken,
  requireAdminAuthApi,
  rateLimitLogin,
  recordFailedLogin,
  clearLoginAttempts
} = require("../middleware/auth");

// POST /api/auth/login
router.post("/login", rateLimitLogin, async (req, res) => {
  const { email, password, remember } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(normalizedEmail);

  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailedLogin(req);
    return res.status(401).json({ error: "Invalid email or password" });
  }

  clearLoginAttempts(req);

  const token = generateAdminToken(user);

  // Set HTTP-only cookie
  const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge
  });

  res.json({
    message: "Authentication successful",
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar: user.avatar
    }
  });
});

// POST /api/auth/logout
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax"
  });
  res.json({ message: "Logged out successfully" });
});

// GET /api/auth/me
router.get("/me", requireAdminAuthApi, (req, res) => {
  res.json({
    authenticated: true,
    user: req.adminUser
  });
});

// PUT /api/auth/profile
router.put("/profile", requireAdminAuthApi, async (req, res) => {
  const { name, currentPassword, newPassword } = req.body;
  const userId = req.adminUser.id;

  if (newPassword) {
    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required to set new password" });
    }
    const user = await db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: "Current password does not match" });
    }
    const newHash = hashPassword(newPassword);
    await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, userId);
  }

  if (name) {
    await db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name.trim(), userId);
  }

  const updatedUser = await db.prepare("SELECT id, name, email, role, avatar FROM users WHERE id = ?").get(userId);
  res.json({ message: "Profile updated successfully", user: updatedUser });
});

module.exports = router;
