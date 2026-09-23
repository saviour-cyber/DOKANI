const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAdminAuthApi, optionalCustomerAuth } = require("../middleware/auth");

// Utility to normalize Kenyan phone numbers
function normalizeKenyanPhone(phone) {
  if (!phone) return "";
  let p = phone.replace(/[\s\-\(\)]/g, "");
  if (p.startsWith("+254")) return p;
  if (p.startsWith("254")) return `+${p}`;
  if (p.startsWith("07") || p.startsWith("01")) return `+254${p.substring(1)}`;
  return p;
}

// POST /api/orders (Public Customer Checkout - guest or logged-in)
router.post("/", optionalCustomerAuth, async (req, res) => {
  const {
    customer_name,
    customer_phone,
    customer_email,
    delivery_address,
    fulfillment_type,
    payment_method,
    items,
    promo_code,
    notes
  } = req.body;

  if (!customer_name || !customer_phone) {
    return res.status(400).json({ error: "Customer name and phone number are required" });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Cart is empty. Please add items before checking out." });
  }

  const normalizedPhone = normalizeKenyanPhone(customer_phone);

  try {
    // 1. Calculate items subtotal and verify stock
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const prod = await db.prepare("SELECT * FROM products WHERE id = ?").get(item.id || item.product_id);
      if (!prod) {
        return res.status(400).json({ error: `Product not found: ${item.name || item.id}` });
      }

      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      if (prod.stock < qty) {
        return res.status(400).json({
          error: `Insufficient stock for "${prod.name}". Only ${prod.stock} available.`
        });
      }

      const unitPrice = prod.sale_price || prod.price;
      const itemTotal = unitPrice * qty;
      subtotal += itemTotal;

      validatedItems.push({
        product_id: prod.id,
        product_name: prod.name,
        product_image: prod.image,
        price: unitPrice,
        quantity: qty,
        total: itemTotal,
        currentStock: prod.stock,
        lowThreshold: prod.low_stock_threshold
      });
    }

    // 2. Validate Promotion if any
    let discountAmount = 0;
    if (promo_code) {
      const promo = await db.prepare("SELECT * FROM promotions WHERE UPPER(code) = UPPER(?) AND is_active = 1").get(promo_code.trim());
      if (promo) {
        if (!promo.min_spend || subtotal >= promo.min_spend) {
          if (promo.discount_type === "Percentage") {
            discountAmount = Math.round((subtotal * promo.discount_value) / 100);
          } else {
            discountAmount = Math.min(subtotal, promo.discount_value);
          }
        }
      }
    }

    // 3. Calculate Delivery Fee
    const deliverySetting = await db.prepare("SELECT value FROM settings WHERE key = 'delivery_fee'").get();
    const freeThresholdSetting = await db.prepare("SELECT value FROM settings WHERE key = 'free_delivery_threshold'").get();

    const baseDeliveryFee = deliverySetting ? parseFloat(deliverySetting.value) : 350;
    const freeThreshold = freeThresholdSetting ? parseFloat(freeThresholdSetting.value) : 5000;

    let deliveryFee = 0;
    if (fulfillment_type !== "Pickup") {
      deliveryFee = (subtotal - discountAmount) >= freeThreshold ? 0 : baseDeliveryFee;
    }

    const total = Math.max(0, subtotal - discountAmount + deliveryFee);
    const orderId = `DK-${Math.floor(10000 + Math.random() * 90000)}`;

    // 4. Create or link customer
    let customerId;
    if (req.customerAccount && req.customerAccount.customer_id) {
      customerId = req.customerAccount.customer_id;
      await db.prepare(`
        UPDATE customers SET
          name = ?,
          email = COALESCE(?, email),
          address = COALESCE(?, address),
          total_spent = total_spent + ?,
          orders_count = orders_count + 1
        WHERE id = ?
      `).run(customer_name.trim(), customer_email || null, delivery_address || null, total, customerId);
    } else {
      const existingCust = await db.prepare("SELECT * FROM customers WHERE phone = ? OR (email IS NOT NULL AND LOWER(email) = ?)").get(normalizedPhone, (customer_email || "").toLowerCase());
      if (existingCust) {
        customerId = existingCust.id;
        await db.prepare(`
          UPDATE customers SET
            name = ?,
            email = COALESCE(?, email),
            address = COALESCE(?, address),
            total_spent = total_spent + ?,
            orders_count = orders_count + 1
          WHERE id = ?
        `).run(customer_name.trim(), customer_email || null, delivery_address || null, total, customerId);
      } else {
        customerId = `cust_${Date.now()}`;
        await db.prepare(`
          INSERT INTO customers (id, name, email, phone, address, total_spent, orders_count)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(customerId, customer_name.trim(), customer_email || null, normalizedPhone, delivery_address || null, total);
      }

      // If customer was logged in but didn't have customer_id attached, link it now
      if (req.customerAccount && !req.customerAccount.customer_id) {
        await db.prepare("UPDATE customer_accounts SET customer_id = ? WHERE id = ?").run(customerId, req.customerAccount.id);
      }
    }

    // 5. Insert Order
    const payMethod = payment_method || "M-Pesa";
    const initialPayStatus = "Pending";
    const initialOrderStatus = "Pending";

    await db.prepare(`
      INSERT INTO orders (
        id, customer_id, customer_name, customer_email, customer_phone,
        delivery_address, fulfillment_type, payment_method, payment_status,
        order_status, subtotal, discount_amount, delivery_fee, total, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      customerId,
      customer_name.trim(),
      customer_email || null,
      normalizedPhone,
      delivery_address || (fulfillment_type === "Pickup" ? "Dokani Store Pickup (Nairobi CBD)" : "Nairobi"),
      fulfillment_type || "Delivery",
      payMethod,
      initialPayStatus,
      initialOrderStatus,
      subtotal,
      discountAmount,
      deliveryFee,
      total,
      notes || ""
    );

    // 6. Insert Order Items & Deduct Stock
    const itemStmt = db.prepare(`
      INSERT INTO order_items (id, order_id, product_id, product_name, product_image, price, quantity, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const stockStmt = db.prepare("UPDATE products SET stock = ?, status = ?, sales = sales + ? WHERE id = ?");
    const invStmt = db.prepare(`
      INSERT INTO inventory_movements (id, product_id, change_type, quantity, previous_stock, new_stock, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of validatedItems) {
      await itemStmt.run(
        `item_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        orderId,
        it.product_id,
        it.product_name,
        it.product_image,
        it.price,
        it.quantity,
        it.total
      );

      const newStock = it.currentStock - it.quantity;
      const newStatus = newStock === 0 ? "Out of Stock" : (newStock <= it.lowThreshold ? "Low Stock" : "Published");
      await stockStmt.run(newStock, newStatus, it.quantity, it.product_id);

      await invStmt.run(
        `inv_${Date.now()}_${it.product_id}`,
        it.product_id,
        "Order",
        it.quantity,
        it.currentStock,
        newStock,
        `Customer order ${orderId}`
      );
    }

    // 7. Insert Payment record
    const refCode = payMethod === "M-Pesa"
      ? `MPESA-${Math.floor(100000 + Math.random() * 900000)}`
      : `REF-${Math.floor(100000 + Math.random() * 900000)}`;

    await db.prepare(`
      INSERT INTO payments (
        id, order_id, amount, method, payment_method, provider,
        phone_number, status, currency, transaction_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'KES', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      `pay_${orderId}`,
      orderId,
      total,
      payMethod,
      payMethod === "M-Pesa" ? "mpesa_stk" : payMethod,
      payMethod === "M-Pesa" ? "mpesa" : "manual",
      normalizedPhone,
      initialPayStatus,
      refCode
    );

    // 8. Create Admin Notification
    await db.prepare(`
      INSERT INTO notifications (id, title, message, type)
      VALUES (?, ?, ?, ?)
    `).run(
      `notif_${Date.now()}`,
      `New Order ${orderId}`,
      `${customer_name.trim()} placed order for KSh ${total.toLocaleString()} (${payMethod})`,
      "order"
    );

    res.status(201).json({
      success: true,
      message: "Order placed successfully!",
      order: {
        id: orderId,
        customer_name,
        customer_phone: normalizedPhone,
        total,
        payment_method: payMethod,
        payment_status: initialPayStatus,
        order_status: initialOrderStatus,
        fulfillment_type: fulfillment_type || "Delivery"
      }
    });
  } catch (err) {
    console.error("Order creation error:", err);
    res.status(500).json({ error: "Failed to place order. Please try again." });
  }
});

// GET /api/orders (Admin list with pagination & filters)
router.get("/", requireAdminAuthApi, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
    const status = req.query.status;
    const search = req.query.search;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (status && status !== "All") {
      whereClause += " AND order_status = ?";
      params.push(status);
    }

    if (search) {
      const q = `%${search.trim().toLowerCase()}%`;
      whereClause += " AND (LOWER(id) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(customer_phone) LIKE ?)";
      params.push(q, q, q);
    }

    const countRow = await db.prepare(`SELECT count(*) as total FROM orders ${whereClause}`).get(...params);
    const total = countRow.total;

    const offset = (page - 1) * limit;
    const orders = await db.prepare(`
      SELECT * FROM orders
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Fetch items for each order
    const itemStmt = db.prepare("SELECT * FROM order_items WHERE order_id = ?");
    const enhancedOrders = [];
    for (const o of orders) {
      const items = await itemStmt.all(o.id);
      enhancedOrders.push({
        ...o,
        items,
        itemCount: items.reduce((acc, it) => acc + it.quantity, 0),
        firstProduct: items[0] || { product_name: "General Item", product_image: "" }
      });
    }

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: enhancedOrders
    });
  } catch (err) {
    console.error("Orders list error:", err);
    res.status(500).json({ error: "Failed to load orders" });
  }
});

// GET /api/orders/:id (Admin single order detail)
router.get("/:id", requireAdminAuthApi, async (req, res) => {
  try {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    const payments = await db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC").all(order.id);
    const latestPayment = payments[0] || null;

    res.json({
      ...order,
      items,
      payments,
      payment: latestPayment,
      mpesa_receipt_number: latestPayment?.mpesa_receipt_number || latestPayment?.transaction_ref || null
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load order details" });
  }
});

// PATCH /api/orders/:id/status (Admin update order status)
router.patch("/:id/status", requireAdminAuthApi, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["Pending", "Confirmed", "Processing", "Ready for Pickup", "Out for Delivery", "Completed", "Cancelled"];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
  }

  try {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    await db.prepare("UPDATE orders SET order_status = ? WHERE id = ?").run(status, req.params.id);
    const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    res.json({ message: "Order status updated", order: updated });
  } catch (err) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

// PATCH /api/orders/:id/payment (Admin update payment status)
router.patch("/:id/payment", requireAdminAuthApi, async (req, res) => {
  const { payment_status } = req.body;
  const validStatuses = ["Pending", "Paid", "Failed", "Refunded"];

  if (!payment_status || !validStatuses.includes(payment_status)) {
    return res.status(400).json({ error: `Invalid payment status. Must be one of: ${validStatuses.join(", ")}` });
  }

  try {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    await db.prepare("UPDATE orders SET payment_status = ? WHERE id = ?").run(payment_status, req.params.id);
    await db.prepare("UPDATE payments SET status = ? WHERE order_id = ?").run(payment_status, req.params.id);

    res.json({ message: "Payment status updated", payment_status });
  } catch (err) {
    res.status(500).json({ error: "Failed to update payment status" });
  }
});

// PATCH /api/orders/:id/cancel (Admin cancel order)
router.patch("/:id/cancel", requireAdminAuthApi, async (req, res) => {
  try {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (order.order_status === "Cancelled") {
      return res.status(400).json({ error: "Order is already cancelled" });
    }

    // Restore stock
    const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    const stockStmt = db.prepare("UPDATE products SET stock = stock + ?, sales = MAX(0, sales - ?) WHERE id = ?");
    const invStmt = db.prepare(`
      INSERT INTO inventory_movements (id, product_id, change_type, quantity, previous_stock, new_stock, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of items) {
      const prod = await db.prepare("SELECT stock FROM products WHERE id = ?").get(it.product_id);
      if (prod) {
        await stockStmt.run(it.quantity, it.quantity, it.product_id);
        await invStmt.run(
          `inv_${Date.now()}_${it.product_id}`,
          it.product_id,
          "Return",
          it.quantity,
          prod.stock,
          prod.stock + it.quantity,
          `Cancelled order ${order.id}`
        );
      }
    }

    await db.prepare("UPDATE orders SET order_status = 'Cancelled' WHERE id = ?").run(order.id);
    res.json({ message: "Order cancelled and stock restored successfully" });
  } catch (err) {
    console.error("Cancel order error:", err);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

// GET /api/orders/:id/invoice (Printable Invoice HTML)
router.get("/:id/invoice", requireAdminAuthApi, async (req, res) => {
  try {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).send("Order not found");

    const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    const payment = await db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC").get(order.id);
    const storeName = (await db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get())?.value || "Dokani";
    const storePhone = (await db.prepare("SELECT value FROM settings WHERE key = 'phone'").get())?.value || "+254 712 345 678";
    const storeEmail = (await db.prepare("SELECT value FROM settings WHERE key = 'email'").get())?.value || "info@dokani.co.ke";
    const storeAddr = (await db.prepare("SELECT value FROM settings WHERE key = 'address'").get())?.value || "Nairobi, Kenya";

    const rows = items.map((it, idx) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${idx + 1}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>${it.product_name}</strong></td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${it.quantity}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">KSh ${it.price.toLocaleString()}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">KSh ${it.total.toLocaleString()}</td>
      </tr>
    `).join("");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Invoice - ${order.id}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #1e293b; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #4f46e5; padding-bottom: 20px; }
          .title { font-size: 24px; font-weight: bold; color: #4f46e5; }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: bold; background: #e0e7ff; color: #3730a3; }
          table { width: 100%; border-collapse: collapse; margin-top: 25px; }
          th { background: #f8fafc; text-align: left; padding: 10px; border-bottom: 2px solid #cbd5e1; font-size: 12px; text-transform: uppercase; color: #64748b; }
          .totals { margin-top: 20px; float: right; width: 300px; }
          .totals table td { padding: 6px 10px; }
          @media print { .no-print { display: none; } body { margin: 0; } }
        </style>
      </head>
      <body>
        <div class="no-print" style="margin-bottom: 20px;">
          <button onclick="window.print()" style="padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;">Print Invoice</button>
        </div>
        <div class="header">
          <div>
            <div class="title">${storeName}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">${storeAddr}</div>
            <div style="font-size: 13px; color: #64748b;">${storePhone} • ${storeEmail}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 20px; font-weight: bold;">INVOICE</div>
            <div style="font-size: 14px; font-family: monospace; font-weight: bold; color: #4f46e5;">#${order.id}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">Date: ${order.created_at}</div>
            <div style="margin-top: 6px;"><span class="badge">${order.order_status}</span></div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; margin-top: 25px;">
          <div>
            <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: bold;">Billed / Delivered To:</div>
            <div style="font-size: 15px; font-weight: bold; margin-top: 4px;">${order.customer_name}</div>
            <div style="font-size: 13px; color: #334155;">Phone: ${order.customer_phone}</div>
            <div style="font-size: 13px; color: #334155;">Address: ${order.delivery_address}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: bold;">Payment Details:</div>
            <div style="font-size: 13px; margin-top: 4px;">Method: <strong>${order.payment_method}</strong></div>
            <div style="font-size: 13px;">Status: <strong>${order.payment_status}</strong></div>
            ${payment?.mpesa_receipt_number ? `<div style="font-size: 13px; color: #4f46e5;">M-Pesa Receipt: <strong>${payment.mpesa_receipt_number}</strong></div>` : ''}
            <div style="font-size: 13px;">Fulfillment: <strong>${order.fulfillment_type}</strong></div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Item Description</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Unit Price</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <div class="totals">
          <table>
            <tr>
              <td style="color: #64748b;">Subtotal:</td>
              <td style="text-align: right; font-weight: bold;">KSh ${order.subtotal.toLocaleString()}</td>
            </tr>
            ${order.discount_amount > 0 ? `
            <tr>
              <td style="color: #16a34a;">Discount:</td>
              <td style="text-align: right; color: #16a34a; font-weight: bold;">- KSh ${order.discount_amount.toLocaleString()}</td>
            </tr>` : ""}
            <tr>
              <td style="color: #64748b;">Delivery Fee:</td>
              <td style="text-align: right; font-weight: bold;">${order.delivery_fee > 0 ? `KSh ${order.delivery_fee.toLocaleString()}` : "FREE"}</td>
            </tr>
            <tr style="border-top: 2px solid #cbd5e1; font-size: 16px;">
              <td style="font-weight: bold; padding-top: 10px;">Total Due:</td>
              <td style="text-align: right; font-weight: bold; color: #4f46e5; padding-top: 10px;">KSh ${order.total.toLocaleString()}</td>
            </tr>
          </table>
        </div>

        <div style="clear: both; margin-top: 60px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
          Thank you for shopping with ${storeName}. For inquiries, contact ${storePhone} or ${storeEmail}.
        </div>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    res.status(500).send("Error generating invoice");
  }
});

module.exports = router;
