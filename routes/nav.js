const express = require("express");
const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    navMain: [
      { id: "dashboard", label: "Dashboard", icon: "layout-dashboard", route: "dashboard" },
      { id: "orders", label: "Orders", icon: "shopping-bag", route: "orders" },
      { id: "payments", label: "Payments", icon: "credit-card", route: "payments" },
      { id: "products", label: "Products", icon: "package", route: "products" },
      { id: "customers", label: "Customers", icon: "users", route: "customers" }
    ],
    navStore: [
      { id: "categories", label: "Categories", icon: "tags", route: "categories" },
      { id: "inventory", label: "Inventory", icon: "boxes", route: "inventory" },
      { id: "promotions", label: "Promotions", icon: "badge-percent", route: "promotions" },
      { id: "reviews", label: "Reviews", icon: "star", route: "reviews" }
    ],
    navOperations: [
      { id: "returns", label: "Returns", icon: "rotate-ccw", route: "returns" },
      { id: "messages", label: "Messages", icon: "message-square", route: "messages" },
      { id: "calendar", label: "Calendar", icon: "calendar", route: "calendar" }
    ],
    navAnalytics: [
      { id: "analytics", label: "Analytics", icon: "bar-chart-3", route: "analytics" },
      { id: "reports", label: "Reports", icon: "file-text", route: "reports" }
    ],
    navSystem: [
      { id: "settings", label: "Settings", icon: "settings", route: "settings" },
      { id: "help", label: "Help & Support", icon: "help-circle", route: "help" }
    ]
  });
});

module.exports = router;
