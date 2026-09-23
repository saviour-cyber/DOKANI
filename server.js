const express = require("express");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
const { requireAdminAuthWeb, requireCustomerAuthWeb } = require("./middleware/auth");

// Initialize database
require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (essential for Render / Cloud load balancers to correctly handle HTTPS and cookies)
app.set("trust proxy", 1);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Customer Storefront Pages ───────────────────────────────────────────────
app.get(["/", "/store", "/shop", "/store/shop", "/store/categories", "/store/deals"], (_req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"));
});

// Customer Auth Pages
app.get("/store/login", (_req, res) => res.sendFile(path.join(__dirname, "store-login.html")));
app.get("/store/register", (_req, res) => res.sendFile(path.join(__dirname, "store-register.html")));
app.get("/store/forgot-password", (_req, res) => res.sendFile(path.join(__dirname, "store-forgot.html")));

// Customer Account Portal Pages (Protected)
app.get([
  "/store/account",
  "/store/orders",
  "/store/orders/:id",
  "/store/tracking",
  "/store/tracking/:id",
  "/store/profile",
  "/store/addresses",
  "/store/wishlist",
  "/store/password",
  "/store/support",
  "/store/help"
], requireCustomerAuthWeb, (_req, res) => {
  res.sendFile(path.join(__dirname, "store-account.html"));
});

// Admin login route (Public)
app.get("/admin/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin-login.html"));
});

// ── Protected Admin Portal Pages ────────────────────────────────────────────
// Legacy /dashboard redirect
app.get("/dashboard", (_req, res) => res.redirect("/admin"));

// Protect all /admin routes (except /admin/login handled above)
app.use("/admin", requireAdminAuthWeb, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Serve static assets (images, css, etc.) ──────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── API Routes ──────────────────────────────────────────────────────────────
app.use("/api/auth",          require("./routes/auth"));
app.use("/api/customer/auth", require("./routes/customer-auth"));
app.use("/api/customer",      require("./routes/customer-portal"));
app.use("/api/stats",         require("./routes/stats"));
app.use("/api/orders",        require("./routes/orders"));
app.use("/api/products",      require("./routes/products"));
app.use("/api/categories",    require("./routes/categories"));
app.use("/api/inventory",     require("./routes/inventory"));
app.use("/api/customers",     require("./routes/customers"));
app.use("/api/promotions",    require("./routes/promotions"));
app.use("/api/returns",       require("./routes/returns"));
app.use("/api/reviews",       require("./routes/reviews"));
app.use("/api/reports",       require("./routes/reports"));
app.use("/api/settings",      require("./routes/settings"));
app.use("/api/nav",           require("./routes/nav"));
app.use("/api/user",          require("./routes/user"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/payments",      require("./routes/payments"));
app.use("/api/admin",         require("./routes/admin-payments"));

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", message: "Dokani Single-Business Ecommerce API is running", currency: "KSh" })
);

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Dokani Single-Business Ecommerce running on port ${PORT}`)
);
