const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireCustomerAuthApi } = require("../middleware/auth");

// All routes here require customer authentication
router.use(requireCustomerAuthApi);

// GET /api/customer/orders (List my orders)
router.get("/orders", async (req, res) => {
  try {
    const customerId = req.customerAccount.customer_id;
    const email = (req.customerAccount.email || "").toLowerCase();
    const phone = req.customerAccount.phone;

    // Fetch orders matching customer_id, or matching email/phone
    const orders = await db.prepare(`
      SELECT o.*,
        (SELECT count(*) FROM order_items WHERE order_id = o.id) as items_count
      FROM orders o
      WHERE (o.customer_id IS NOT NULL AND o.customer_id = ?)
         OR (o.customer_email IS NOT NULL AND LOWER(o.customer_email) = ?)
         OR (o.customer_phone IS NOT NULL AND o.customer_phone = ?)
      ORDER BY o.created_at DESC
    `).all(customerId || "", email, phone);

    // Attach item preview for each order
    const itemStmt = db.prepare(`
      SELECT product_id, product_name, product_image, price, quantity, total
      FROM order_items
      WHERE order_id = ?
    `);

    const result = [];
    for (const order of orders) {
      result.push({
        ...order,
        items: await itemStmt.all(order.id)
      });
    }

    res.json(result);
  } catch (err) {
    console.error("Customer orders error:", err);
    res.status(500).json({ error: "Failed to load your orders." });
  }
});

// GET /api/customer/orders/:id (Detail of single order)
router.get("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const customerId = req.customerAccount.customer_id;
    const email = (req.customerAccount.email || "").toLowerCase();
    const phone = req.customerAccount.phone;

    const order = await db.prepare(`
      SELECT * FROM orders
      WHERE id = ? AND (
        (customer_id IS NOT NULL AND customer_id = ?)
        OR (customer_email IS NOT NULL AND LOWER(customer_email) = ?)
        OR (customer_phone IS NOT NULL AND customer_phone = ?)
      )
    `).get(orderId, customerId || "", email, phone);

    if (!order) {
      return res.status(404).json({ error: "Order not found or does not belong to your account." });
    }

    const items = await db.prepare(`
      SELECT oi.*, p.stock as current_stock, p.status as product_status
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(orderId);

    const payment = await db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY CASE WHEN status = 'paid' THEN 1 ELSE 2 END, created_at DESC LIMIT 1").get(orderId);

    res.json({
      ...order,
      items,
      payment
    });
  } catch (err) {
    console.error("Customer order detail error:", err);
    res.status(500).json({ error: "Failed to load order details." });
  }
});

// POST /api/customer/orders/:id/reorder (Get items to reorder into cart)
router.post("/orders/:id/reorder", async (req, res) => {
  try {
    const orderId = req.params.id;
    const customerId = req.customerAccount.customer_id;
    const email = (req.customerAccount.email || "").toLowerCase();
    const phone = req.customerAccount.phone;

    const order = await db.prepare(`
      SELECT * FROM orders
      WHERE id = ? AND (
        (customer_id IS NOT NULL AND customer_id = ?)
        OR (customer_email IS NOT NULL AND LOWER(customer_email) = ?)
        OR (customer_phone IS NOT NULL AND customer_phone = ?)
      )
    `).get(orderId, customerId || "", email, phone);

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    const items = await db.prepare(`
      SELECT oi.product_id, oi.product_name, oi.quantity,
             p.id, p.name, p.price, p.sale_price, p.stock, p.image, p.status
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(orderId);

    // Return current product info
    const reorderItems = items.map(item => ({
      id: item.id,
      name: item.name,
      price: item.sale_price || item.price,
      image: item.image,
      quantity: Math.min(item.quantity, item.stock > 0 ? item.stock : item.quantity),
      inStock: item.stock > 0,
      currentStock: item.stock
    }));

    res.json({
      message: "Reorder items prepared",
      items: reorderItems
    });
  } catch (err) {
    console.error("Reorder error:", err);
    res.status(500).json({ error: "Unable to prepare reorder items." });
  }
});

// GET /api/customer/wishlist (Get customer's wishlist items)
router.get("/wishlist", async (req, res) => {
  try {
    const accountId = req.customerAccount.id;

    const items = await db.prepare(`
      SELECT w.id as wishlist_id, w.added_at,
             p.id, p.name, p.slug, p.price, p.sale_price, p.stock, p.image, p.rating, p.status, p.category_name
      FROM wishlists w
      JOIN products p ON w.product_id = p.id
      WHERE w.customer_account_id = ?
      ORDER BY w.added_at DESC
    `).all(accountId);

    res.json(items);
  } catch (err) {
    console.error("Wishlist get error:", err);
    res.status(500).json({ error: "Failed to load wishlist." });
  }
});

// POST /api/customer/wishlist (Add item to wishlist)
router.post("/wishlist", async (req, res) => {
  try {
    const accountId = req.customerAccount.id;
    const { product_id } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: "Product ID is required." });
    }

    const prod = await db.prepare("SELECT id, name FROM products WHERE id = ?").get(product_id);
    if (!prod) {
      return res.status(404).json({ error: "Product not found." });
    }

    const wishId = `wish_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await db.prepare(`
      INSERT OR IGNORE INTO wishlists (id, customer_account_id, product_id)
      VALUES (?, ?, ?)
    `).run(wishId, accountId, product_id);

    res.status(201).json({ message: `"${prod.name}" added to your wishlist.`, product_id });
  } catch (err) {
    console.error("Wishlist add error:", err);
    res.status(500).json({ error: "Failed to add product to wishlist." });
  }
});

// DELETE /api/customer/wishlist/:product_id (Remove item from wishlist)
router.delete("/wishlist/:product_id", async (req, res) => {
  try {
    const accountId = req.customerAccount.id;
    const productId = req.params.product_id;

    await db.prepare(`
      DELETE FROM wishlists
      WHERE customer_account_id = ? AND product_id = ?
    `).run(accountId, productId);

    res.json({ message: "Product removed from wishlist.", product_id: productId });
  } catch (err) {
    console.error("Wishlist remove error:", err);
    res.status(500).json({ error: "Failed to remove from wishlist." });
  }
});

// GET /api/customer/addresses (Get saved delivery address)
router.get("/addresses", async (req, res) => {
  try {
    const customerId = req.customerAccount.customer_id;
    if (!customerId) {
      return res.json({ address: null });
    }
    const cust = await db.prepare("SELECT address FROM customers WHERE id = ?").get(customerId);
    res.json({ address: cust ? cust.address : null });
  } catch (err) {
    res.status(500).json({ error: "Failed to load address." });
  }
});

// PUT /api/customer/addresses (Update saved delivery address)
router.put("/addresses", async (req, res) => {
  try {
    const { address } = req.body;
    const customerId = req.customerAccount.customer_id;

    if (!address || !address.trim()) {
      return res.status(400).json({ error: "Address cannot be empty." });
    }

    if (customerId) {
      await db.prepare("UPDATE customers SET address = ? WHERE id = ?").run(address.trim(), customerId);
    }

    res.json({ message: "Default delivery address updated successfully.", address: address.trim() });
  } catch (err) {
    console.error("Address update error:", err);
    res.status(500).json({ error: "Failed to update address." });
  }
});

// GET /api/customer/track/:id (Order tracking timeline)
router.get("/track/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const customerId = req.customerAccount.customer_id;
    const email = (req.customerAccount.email || "").toLowerCase();
    const phone = req.customerAccount.phone;

    const order = await db.prepare(`
      SELECT o.*,
        (SELECT count(*) FROM order_items WHERE order_id = o.id) as items_count
      FROM orders o
      WHERE o.id = ? AND (
        (o.customer_id IS NOT NULL AND o.customer_id = ?)
        OR (o.customer_email IS NOT NULL AND LOWER(o.customer_email) = ?)
        OR (o.customer_phone IS NOT NULL AND o.customer_phone = ?)
      )
    `).get(orderId, customerId || "", email, phone);

    if (!order) {
      return res.status(404).json({ error: `Order ${orderId} not found in your account.` });
    }

    const items = await db.prepare("SELECT product_name, quantity, price, product_image FROM order_items WHERE order_id = ?").all(orderId);

    const statusOrder = ["Pending", "Confirmed", "Processing", "Shipped", "Completed"];
    const currentIdx = statusOrder.indexOf(order.order_status);

    const steps = [
      {
        title: "Order Placed",
        description: `Order received with ${order.payment_method} payment`,
        time: order.created_at,
        completed: true,
        current: order.order_status === "Pending"
      },
      {
        title: "Order Confirmed",
        description: order.payment_status === "Paid" ? "Payment verified & approved" : "Order acknowledged by Dokani",
        time: currentIdx >= 1 ? order.created_at : null,
        completed: currentIdx >= 1,
        current: order.order_status === "Confirmed"
      },
      {
        title: "Processing & Packing",
        description: "Items prepared at Dokani Nairobi CBD fulfillment hub",
        time: currentIdx >= 2 ? "In progress" : null,
        completed: currentIdx >= 2,
        current: order.order_status === "Processing"
      },
      {
        title: "In Transit / Out for Delivery",
        description: order.fulfillment_type === "Pickup" ? "Ready for collection at Dokani Kimathi St" : "Dispatched with Dokani Express Courier",
        time: currentIdx >= 3 ? "On the road" : null,
        completed: currentIdx >= 3,
        current: order.order_status === "Shipped"
      },
      {
        title: "Delivered",
        description: "Package delivered to recipient",
        time: currentIdx >= 4 ? "Delivered" : null,
        completed: currentIdx >= 4,
        current: order.order_status === "Completed"
      }
    ];

    res.json({
      order,
      items,
      carrier: order.fulfillment_type === "Pickup" ? "Dokani Store Pickup" : "Dokani Express Courier (Fargo / G4S Kenya)",
      estimatedDelivery: "1 - 2 Business Days",
      trackingNumber: `TRK-${order.id.replace('DK-', '')}-KE`,
      steps
    });
  } catch (err) {
    console.error("Order tracking error:", err);
    res.status(500).json({ error: "Failed to retrieve order tracking information." });
  }
});

// POST /api/customer/support (Customer message / support inquiry)
router.post("/support", async (req, res) => {
  try {
    const { subject, message, order_id } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Please enter your support message." });
    }

    const customerName = req.customerAccount.name || "Customer";
    const customerPhone = req.customerAccount.phone || "";

    const notifId = `notif_${Date.now()}`;
    const title = `Support Request: ${subject ? subject.trim() : 'General Inquiry'}`;
    const text = `From: ${customerName} (${customerPhone}) ${order_id ? 'Ref: ' + order_id : ''}\n${message.trim()}`;

    await db.prepare(`
      INSERT INTO notifications (id, title, message, type, is_read)
      VALUES (?, ?, ?, 'support', 0)
    `).run(notifId, title, text);

    res.status(201).json({
      message: "Thank you! Your inquiry has been sent to our customer care team. We will reply via WhatsApp or phone within 2 hours.",
      inquiry_id: notifId
    });
  } catch (err) {
    console.error("Support inquiry error:", err);
    res.status(500).json({ error: "Failed to submit support request." });
  }
});

module.exports = router;
