const jwt = require("jsonwebtoken");
const { db } = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "dokani-secure-staff-secret-2026-key";
const COOKIE_NAME = "dokani_admin_token";

// In-memory rate limiting map: ip -> { count, resetTime }
const loginAttempts = new Map();

function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown_ip";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 5;

  const record = loginAttempts.get(ip);
  if (record) {
    if (now > record.resetTime) {
      loginAttempts.set(ip, { count: 1, resetTime: now + windowMs });
    } else if (record.count >= maxAttempts) {
      const waitMins = Math.ceil((record.resetTime - now) / 60000);
      return res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${waitMins} minute(s).`
      });
    }
  } else {
    loginAttempts.set(ip, { count: 0, resetTime: now + windowMs });
  }
  next();
}

function recordFailedLogin(req) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown_ip";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const record = loginAttempts.get(ip) || { count: 0, resetTime: now + windowMs };
  record.count += 1;
  loginAttempts.set(ip, record);
}

function clearLoginAttempts(req) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown_ip";
  loginAttempts.delete(ip);
}

function extractToken(req) {
  // Check cookie first
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  return null;
}

async function verifyUserFromToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.userId) return null;
    const user = await db.prepare("SELECT id, name, email, role, avatar FROM users WHERE id = ?").get(decoded.userId);
    return user || null;
  } catch (err) {
    return null;
  }
}

// Middleware for API routes that require admin authentication
async function requireAdminAuthApi(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Admin authentication required" });
  }

  const user = await verifyUserFromToken(token);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired session" });
  }

  req.adminUser = user;
  next();
}

// Middleware for Web routes (/admin, /admin/*)
async function requireAdminAuthWeb(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.redirect("/admin/login");
  }

  const user = await verifyUserFromToken(token);
  if (!user) {
    res.clearCookie(COOKIE_NAME);
    return res.redirect("/admin/login");
  }

  req.adminUser = user;
  next();
}

// Utility to issue JWT token
function generateAdminToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

const CUSTOMER_COOKIE_NAME = "dokani_customer_token";
const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || "dokani-customer-secret-2026-key";

// Customer token extraction
function extractCustomerToken(req) {
  if (req.cookies && req.cookies[CUSTOMER_COOKIE_NAME]) {
    return req.cookies[CUSTOMER_COOKIE_NAME];
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  return null;
}

// Verify customer from JWT — now async, returns a Promise
async function verifyCustomerFromToken(token) {
  try {
    const decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
    if (!decoded || !decoded.accountId || decoded.role !== "customer") return null;

    const account = await db.prepare(`
      SELECT ca.id, ca.customer_id, ca.name, ca.email, ca.phone, ca.is_verified, ca.is_active, ca.created_at,
             c.address, c.total_spent, c.orders_count
      FROM customer_accounts ca
      LEFT JOIN customers c ON ca.customer_id = c.id
      WHERE ca.id = ? AND ca.is_active = 1
    `).get(decoded.accountId);

    return account || null;
  } catch (err) {
    return null;
  }
}

// Require customer auth for API endpoints
async function requireCustomerAuthApi(req, res, next) {
  const token = extractCustomerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Please log in to access your customer account." });
  }

  const account = await verifyCustomerFromToken(token);
  if (!account) {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }

  req.customerAccount = account;
  next();
}

// Optional customer auth for public storefront checkout
async function optionalCustomerAuth(req, res, next) {
  const token = extractCustomerToken(req);
  if (token) {
    const account = await verifyCustomerFromToken(token);
    if (account) {
      req.customerAccount = account;
    }
  }
  next();
}

// Require customer auth for web pages
async function requireCustomerAuthWeb(req, res, next) {
  const token = extractCustomerToken(req);
  if (!token) {
    const returnUrl = encodeURIComponent(req.originalUrl || "/store/account");
    return res.redirect(`/store/login?redirect=${returnUrl}`);
  }

  const account = await verifyCustomerFromToken(token);
  if (!account) {
    res.clearCookie(CUSTOMER_COOKIE_NAME);
    const returnUrl = encodeURIComponent(req.originalUrl || "/store/account");
    return res.redirect(`/store/login?redirect=${returnUrl}`);
  }

  req.customerAccount = account;
  next();
}

// Generate customer JWT token
function generateCustomerToken(account) {
  return jwt.sign(
    {
      accountId: account.id,
      customerId: account.customer_id,
      email: account.email,
      role: "customer"
    },
    CUSTOMER_JWT_SECRET,
    { expiresIn: "30d" }
  );
}

module.exports = {
  COOKIE_NAME,
  generateAdminToken,
  requireAdminAuthApi,
  requireAdminAuthWeb,
  rateLimitLogin,
  recordFailedLogin,
  clearLoginAttempts,
  // Customer exports
  CUSTOMER_COOKIE_NAME,
  generateCustomerToken,
  requireCustomerAuthApi,
  optionalCustomerAuth,
  requireCustomerAuthWeb,
  extractCustomerToken,
  verifyCustomerFromToken
};
