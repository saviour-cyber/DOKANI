const express = require("express");
const router = express.Router();
const { db, hashPassword, verifyPassword } = require("../db");
const {
  CUSTOMER_COOKIE_NAME,
  generateCustomerToken,
  requireCustomerAuthApi,
  rateLimitLogin,
  recordFailedLogin,
  clearLoginAttempts
} = require("../middleware/auth");

// Kenyan phone normalization
function normalizeKenyanPhone(phone) {
  if (!phone) return "";
  let p = phone.toString().replace(/[\s\-\(\)\.]/g, "");
  if (p.startsWith("+254")) return p;
  if (p.startsWith("254")) return `+${p}`;
  if (p.startsWith("07") || p.startsWith("01")) return `+254${p.substring(1)}`;
  if (/^[71]\d{8}$/.test(p)) return `+254${p}`;
  return p;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidKenyanPhone(phone) {
  const norm = normalizeKenyanPhone(phone);
  return /^\+254(7|1)\d{8}$/.test(norm);
}

// POST /api/customer/auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, phone, email, password, confirmPassword } = req.body;

    // 1. Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Please enter your full name." });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: "Please enter your phone number." });
    }
    if (!isValidKenyanPhone(phone)) {
      return res.status(400).json({ error: "Please enter a valid Kenyan phone number (e.g. 0712 345 678 or 0110 123 456)." });
    }
    if (!email || !email.trim() || !isValidEmail(email.trim())) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalizeKenyanPhone(phone);

    // 2. Check duplicate email
    const existingByEmail = await db.prepare("SELECT id FROM customer_accounts WHERE LOWER(email) = ?").get(normalizedEmail);
    if (existingByEmail) {
      return res.status(400).json({ error: "An account with this email address already exists. Please log in." });
    }

    // 3. Check duplicate phone in customer_accounts
    const existingByPhone = await db.prepare("SELECT id FROM customer_accounts WHERE phone = ?").get(normalizedPhone);
    if (existingByPhone) {
      return res.status(400).json({ error: "An account with this phone number already exists. Please log in." });
    }

    // 4. Link or create base `customers` record
    let customer = await db.prepare("SELECT * FROM customers WHERE LOWER(email) = ? OR phone = ?").get(normalizedEmail, normalizedPhone);
    let customerId;

    if (customer) {
      customerId = customer.id;
      await db.prepare(`
        UPDATE customers 
        SET name = COALESCE(?, name),
            email = COALESCE(?, email),
            phone = COALESCE(?, phone)
        WHERE id = ?
      `).run(name.trim(), normalizedEmail, normalizedPhone, customerId);
    } else {
      customerId = `cust_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      await db.prepare(`
        INSERT INTO customers (id, name, email, phone, address, total_spent, orders_count, status)
        VALUES (?, ?, ?, ?, ?, 0, 0, 'Active')
      `).run(customerId, name.trim(), normalizedEmail, normalizedPhone, null);
    }

    // 5. Create customer_accounts record
    const accountId = `cacc_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const passwordHash = hashPassword(password);

    await db.prepare(`
      INSERT INTO customer_accounts (id, customer_id, name, email, phone, password_hash, is_verified, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `).run(accountId, customerId, name.trim(), normalizedEmail, normalizedPhone, passwordHash);

    const createdAccount = await db.prepare(`
      SELECT ca.id, ca.customer_id, ca.name, ca.email, ca.phone, ca.created_at,
             c.address, c.total_spent, c.orders_count
      FROM customer_accounts ca
      LEFT JOIN customers c ON ca.customer_id = c.id
      WHERE ca.id = ?
    `).get(accountId);

    // 6. Auto-login: issue JWT
    const token = generateCustomerToken(createdAccount);
    res.cookie(CUSTOMER_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.status(201).json({
      message: "Account created successfully. Welcome to Dokani!",
      token,
      account: createdAccount
    });
  } catch (err) {
    console.error("Customer registration error:", err);
    res.status(500).json({ error: "Unable to complete registration. Please try again." });
  }
});

// POST /api/customer/auth/login
router.post("/login", rateLimitLogin, async (req, res) => {
  try {
    const { identifier, password, remember } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: "Please provide your email/phone and password." });
    }

    const cleanIdentifier = identifier.trim();
    const normalizedPhone = normalizeKenyanPhone(cleanIdentifier);
    const normalizedEmail = cleanIdentifier.toLowerCase();

    // Look up by email or phone
    const account = await db.prepare(`
      SELECT ca.*, c.address, c.total_spent, c.orders_count
      FROM customer_accounts ca
      LEFT JOIN customers c ON ca.customer_id = c.id
      WHERE LOWER(ca.email) = ? OR ca.phone = ? OR ca.phone = ?
    `).get(normalizedEmail, cleanIdentifier, normalizedPhone);

    if (!account || !verifyPassword(password, account.password_hash)) {
      recordFailedLogin(req);
      return res.status(401).json({ error: "Invalid email/phone or password. Please check and try again." });
    }

    if (account.is_active === 0) {
      return res.status(403).json({ error: "Your account is inactive. Please contact Dokani support." });
    }

    clearLoginAttempts(req);

    // Update last_login
    await db.prepare("UPDATE customer_accounts SET last_login = CURRENT_TIMESTAMP WHERE id = ?").run(account.id);

    const token = generateCustomerToken(account);
    const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

    res.cookie(CUSTOMER_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge
    });

    res.json({
      message: "Welcome back!",
      token,
      account: {
        id: account.id,
        customerId: account.customer_id,
        name: account.name,
        email: account.email,
        phone: account.phone,
        address: account.address,
        totalSpent: account.total_spent || 0,
        ordersCount: account.orders_count || 0
      }
    });
  } catch (err) {
    console.error("Customer login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /api/customer/auth/logout
router.post("/logout", (_req, res) => {
  res.clearCookie(CUSTOMER_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax"
  });
  res.json({ message: "Successfully logged out." });
});

// GET /api/customer/auth/me
router.get("/me", requireCustomerAuthApi, (req, res) => {
  res.json({
    authenticated: true,
    account: req.customerAccount
  });
});

// PUT /api/customer/auth/profile
router.put("/profile", requireCustomerAuthApi, async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    const accountId = req.customerAccount.id;
    const customerId = req.customerAccount.customer_id;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required." });
    }

    let normPhone = req.customerAccount.phone;
    if (phone && phone.trim()) {
      normPhone = normalizeKenyanPhone(phone);
      if (!isValidKenyanPhone(normPhone)) {
        return res.status(400).json({ error: "Please enter a valid Kenyan phone number." });
      }
    }

    await db.prepare(`
      UPDATE customer_accounts 
      SET name = ?, phone = ?
      WHERE id = ?
    `).run(name.trim(), normPhone, accountId);

    if (customerId) {
      await db.prepare(`
        UPDATE customers 
        SET name = ?, phone = ?, address = ?
        WHERE id = ?
      `).run(name.trim(), normPhone, address ? address.trim() : null, customerId);
    }

    const updated = await db.prepare(`
      SELECT ca.id, ca.customer_id, ca.name, ca.email, ca.phone, ca.created_at,
             c.address, c.total_spent, c.orders_count
      FROM customer_accounts ca
      LEFT JOIN customers c ON ca.customer_id = c.id
      WHERE ca.id = ?
    `).get(accountId);

    res.json({ message: "Profile updated successfully.", account: updated });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Failed to update profile." });
  }
});

// PUT /api/customer/auth/password
router.put("/password", requireCustomerAuthApi, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const accountId = req.customerAccount.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Please provide your current and new password." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters long." });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "New password and confirmation do not match." });
    }

    const account = await db.prepare("SELECT password_hash FROM customer_accounts WHERE id = ?").get(accountId);
    if (!verifyPassword(currentPassword, account.password_hash)) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const newHash = hashPassword(newPassword);
    await db.prepare("UPDATE customer_accounts SET password_hash = ? WHERE id = ?").run(newHash, accountId);

    res.json({ message: "Password changed successfully." });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Failed to change password." });
  }
});

// POST /api/customer/auth/forgot-password
router.post("/forgot-password", (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email.trim())) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  res.json({
    message: "If an account exists with that email, password reset instructions have been sent. Please check your inbox."
  });
});

module.exports = router;
