const express = require("express");
const router = express.Router();
const { db } = require("../db");
const MpesaService = require("../services/mpesa");
const { optionalCustomerAuth } = require("../middleware/auth");

/**
 * POST /api/payments/mpesa/stk-push
 * Initiate M-Pesa STK Push for an order
 */
router.post("/mpesa/stk-push", optionalCustomerAuth, async (req, res) => {
  try {
    const { orderId, phoneNumber, simulate } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required." });
    }

    if (!phoneNumber) {
      return res.status(400).json({ error: "M-Pesa phone number is required." });
    }

    // 1. Fetch Order and verify
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    // Check if order is already paid
    if (order.payment_status === "Paid") {
      return res.status(400).json({ error: "This order is already paid." });
    }

    // If authenticated customer, verify order belongs to them
    if (req.customerAccount && order.customer_id && req.customerAccount.customer_id) {
      if (order.customer_id !== req.customerAccount.customer_id) {
        return res.status(403).json({ error: "Unauthorized access to this order." });
      }
    }

    // Normalize phone number
    const normalizedPhone = MpesaService.normalizePhone(phoneNumber);
    if (!normalizedPhone) {
      return res.status(400).json({
        error: "Invalid Kenyan phone number. Please enter a valid number (e.g., 0712345678 or 01XXXXXXXX)."
      });
    }

    // 2. Determine payment amount strictly from backend order record (DO NOT trust client amount)
    const amount = order.total;

    // 3. Initiate Daraja STK Push
    const result = await MpesaService.initiateSTKPush({
      orderId: order.id,
      phoneNumber: normalizedPhone,
      amount,
      simulate: Boolean(simulate)
    });

    // 4. Record pending payment attempt
    const paymentId = `pay_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    await db.prepare(`
      INSERT INTO payments (
        id, order_id, method, payment_method, provider, phone_number, amount,
        currency, status, merchant_request_id, checkout_request_id,
        created_at, updated_at
      ) VALUES (?, ?, 'M-Pesa', 'mpesa_stk', 'mpesa', ?, ?, 'KES', 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      paymentId,
      order.id,
      normalizedPhone,
      amount,
      result.merchantRequestId,
      result.checkoutRequestId
    );

    res.status(200).json({
      success: true,
      message: "M-Pesa payment prompt sent to your phone. Please enter your M-Pesa PIN to complete payment.",
      paymentId,
      orderId: order.id,
      checkoutRequestId: result.checkoutRequestId,
      amount,
      phoneFormatted: MpesaService.formatPhoneMasked(normalizedPhone),
      status: "pending"
    });
  } catch (err) {
    console.error("STK Push error:", err.message);
    res.status(500).json({ error: err.message || "Failed to initiate M-Pesa payment." });
  }
});

/**
 * POST /api/payments/mpesa/retry
 * Retry M-Pesa payment on an existing unpaid order (Section 26)
 */
router.post("/mpesa/retry", optionalCustomerAuth, async (req, res) => {
  try {
    const { orderId, phoneNumber, simulate } = req.body;
    if (!orderId) return res.status(400).json({ error: "Order ID is required." });

    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) return res.status(404).json({ error: "Order not found." });

    if (order.payment_status === "Paid") {
      return res.status(400).json({ error: "Order is already paid." });
    }

    const phoneToUse = phoneNumber || order.customer_phone;
    const normalizedPhone = MpesaService.normalizePhone(phoneToUse);
    if (!normalizedPhone) {
      return res.status(400).json({ error: "Invalid Kenyan phone number." });
    }

    const result = await MpesaService.initiateSTKPush({
      orderId: order.id,
      phoneNumber: normalizedPhone,
      amount: order.total,
      simulate: Boolean(simulate)
    });

    const paymentId = `pay_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    await db.prepare(`
      INSERT INTO payments (
        id, order_id, method, payment_method, provider, phone_number, amount,
        currency, status, merchant_request_id, checkout_request_id,
        created_at, updated_at
      ) VALUES (?, ?, 'M-Pesa', 'mpesa_stk', 'mpesa', ?, ?, 'KES', 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      paymentId,
      order.id,
      normalizedPhone,
      order.total,
      result.merchantRequestId,
      result.checkoutRequestId
    );

    res.status(200).json({
      success: true,
      message: "Retry STK push sent. Please enter your M-Pesa PIN.",
      paymentId,
      orderId: order.id,
      checkoutRequestId: result.checkoutRequestId,
      amount: order.total,
      phoneFormatted: MpesaService.formatPhoneMasked(normalizedPhone),
      status: "pending"
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to retry M-Pesa payment." });
  }
});

/**
 * GET /api/payments/:paymentId/status
 * Check current status of a payment attempt with Daraja query fallback & timeout detection
 */
router.get("/:paymentId/status", async (req, res) => {
  try {
    const payment = await db.prepare(`
      SELECT p.*,
             CAST((strftime('%s', 'now') - strftime('%s', p.created_at)) AS INTEGER) as elapsed_sec,
             o.order_status, o.total as order_total, o.customer_name
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      WHERE p.id = ? OR p.checkout_request_id = ?
    `).get(req.params.paymentId, req.params.paymentId);

    if (!payment) {
      return res.status(404).json({ error: "Payment record not found." });
    }

    // If still pending, check Daraja directly or detect timeout
    if (payment.status === "pending") {
      const elapsedSec = Math.max(0, payment.elapsed_sec || 0);

      if (payment.checkout_request_id && elapsedSec >= 10) {
        // Query Daraja STK query endpoint if credentials are configured
        const queryRes = await MpesaService.querySTKStatus(payment.checkout_request_id);
        if (queryRes) {
          const resCode = parseInt(queryRes.ResultCode, 10);
          if (resCode === 0) {
            // Payment succeeded!
            await db.prepare(`
              UPDATE payments SET
                status = 'paid',
                result_code = 0,
                result_description = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(queryRes.ResultDesc || "Paid", payment.id);

            await db.prepare(`
              UPDATE orders SET
                payment_status = 'Paid',
                order_status = CASE WHEN order_status = 'Pending' THEN 'Processing' ELSE order_status END
              WHERE id = ?
            `).run(payment.order_id);

            payment.status = "paid";
            payment.order_status = "Processing";
            payment.result_description = queryRes.ResultDesc;
          } else if (resCode === 1032) {
            await db.prepare(`
              UPDATE payments SET
                status = 'cancelled',
                result_code = 1032,
                result_description = 'Payment was cancelled on phone.',
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(payment.id);
            payment.status = "cancelled";
            payment.result_description = 'Payment was cancelled on phone.';
          } else if (resCode === 1037 || resCode > 0) {
            const finalSt = resCode === 1037 ? 'timeout' : 'failed';
            const desc = resCode === 1037
              ? 'No response from phone (request timed out).'
              : (queryRes.ResultDesc || 'Payment failed on phone.');
            await db.prepare(`
              UPDATE payments SET
                status = ?,
                result_code = ?,
                result_description = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(finalSt, resCode, desc, payment.id);
            payment.status = finalSt;
            payment.result_description = desc;
          }
        } else if (elapsedSec > 45) {
          // If more than 45 seconds have passed with no response from user's phone
          await db.prepare(`
            UPDATE payments SET
              status = 'timeout',
              result_code = 1037,
              result_description = 'No response from phone (request timed out).',
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(payment.id);
          payment.status = 'timeout';
          payment.result_description = 'No response from phone (request timed out).';
        }
      }
    }

    res.json({
      id: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      amount: payment.amount,
      receiptNumber: payment.mpesa_receipt_number,
      transactionDate: payment.transaction_date,
      orderStatus: payment.order_status,
      resultDescription: payment.result_description
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve payment status." });
  }
});

/**
 * POST /api/payments/mpesa/cancel
 * Customer manually cancels waiting modal for pending STK Push
 */
router.post("/mpesa/cancel", async (req, res) => {
  try {
    const { paymentId, orderId } = req.body;
    if (!paymentId && !orderId) {
      return res.status(400).json({ error: "Payment ID or Order ID is required." });
    }

    await db.prepare(`
      UPDATE payments SET
        status = 'cancelled',
        result_code = 1032,
        result_description = 'Cancelled by customer on screen',
        updated_at = CURRENT_TIMESTAMP
      WHERE (id = ? OR order_id = ?) AND status = 'pending'
    `).run(paymentId || "", orderId || "");

    res.json({ success: true, message: "Payment cancelled successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel payment." });
  }
});

/**
 * POST /api/payments/switch-to-cod
 * Switch an unpaid pending order to Cash on Delivery
 */
router.post("/switch-to-cod", async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required." });
    }

    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.payment_status === "Paid") {
      return res.status(400).json({ error: "Order is already paid." });
    }

    // Cancel pending payments
    await db.prepare(`
      UPDATE payments SET
        status = 'cancelled',
        result_description = 'Customer switched to Cash on Delivery',
        updated_at = CURRENT_TIMESTAMP
      WHERE order_id = ? AND status = 'pending'
    `).run(orderId);

    // Update order payment method
    await db.prepare(`
      UPDATE orders SET
        payment_method = 'Cash on Delivery',
        payment_status = 'Pending',
        order_status = 'Pending'
      WHERE id = ?
    `).run(orderId);

    res.json({
      success: true,
      message: "Order successfully switched to Cash on Delivery!",
      order: {
        id: order.id,
        customer_name: order.customer_name,
        total: order.total,
        payment_method: "Cash on Delivery"
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to switch payment method." });
  }
});

/**
 * POST /api/payments/mpesa/callback
 * Safaricom Daraja STK Push Webhook Callback (Section 12 & 13)
 * Strict idempotency: avoids double processing or race conditions.
 */
router.post("/mpesa/callback", async (req, res) => {
  try {
    const callbackData = req.body;
    const stkCallback = callbackData?.Body?.stkCallback;

    if (!stkCallback) {
      // Invalid format, acknowledge Safaricom to stop retries
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

    // 1. Locate payment record by CheckoutRequestID or MerchantRequestID
    const payment = await db.prepare(`
      SELECT * FROM payments
      WHERE checkout_request_id = ? OR merchant_request_id = ?
    `).get(CheckoutRequestID, MerchantRequestID);

    if (!payment) {
      console.warn("M-Pesa Callback: No matching payment found for", CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    // 2. IDEMPOTENCY CHECK (Section 13)
    // If payment is already finalized as 'paid', acknowledge and exit without re-processing
    if (payment.status === "paid") {
      return res.json({ ResultCode: 0, ResultDesc: "Already processed" });
    }

    const rawCallbackJson = JSON.stringify(callbackData);

    // 3. Handle Successful Payment (ResultCode === 0)
    if (ResultCode === 0) {
      let mpesaReceiptNumber = "";
      let transactionDate = "";
      let paidAmount = payment.amount;
      let callbackPhone = payment.phone_number;

      const items = stkCallback.CallbackMetadata?.Item || [];
      for (const item of items) {
        if (item.Name === "MpesaReceiptNumber") mpesaReceiptNumber = String(item.Value);
        if (item.Name === "TransactionDate") transactionDate = String(item.Value);
        if (item.Name === "Amount") paidAmount = Number(item.Value);
        if (item.Name === "PhoneNumber") callbackPhone = String(item.Value);
      }

      // Update payment record to 'paid'
      await db.prepare(`
        UPDATE payments SET
          status = 'paid',
          mpesa_receipt_number = ?,
          transaction_date = ?,
          amount = ?,
          phone_number = COALESCE(phone_number, ?),
          result_code = ?,
          result_description = ?,
          raw_callback = ?,
          callback_received_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        mpesaReceiptNumber,
        transactionDate || new Date().toISOString(),
        paidAmount,
        callbackPhone,
        ResultCode,
        ResultDesc,
        rawCallbackJson,
        payment.id
      );

      // Update order record to 'Paid' and order_status to 'Processing'
      await db.prepare(`
        UPDATE orders SET
          payment_status = 'Paid',
          order_status = CASE WHEN order_status = 'Pending' THEN 'Processing' ELSE order_status END
        WHERE id = ?
      `).run(payment.order_id);

      // Create Admin notification
      await db.prepare(`
        INSERT INTO notifications (id, title, message, type)
        VALUES (?, ?, ?, 'order')
      `).run(
        `notif_${Date.now()}`,
        `M-Pesa Payment Confirmed (${mpesaReceiptNumber})`,
        `Order ${payment.order_id} paid via M-Pesa: KSh ${paidAmount.toLocaleString()} (Receipt: ${mpesaReceiptNumber})`
      );

      // Record in audit log
      await db.prepare(`
        INSERT INTO payment_audit_logs (id, admin_id, admin_name, action, details)
        VALUES (?, 'system', 'Safaricom Daraja Webhook', 'Payment Confirmed', ?)
      `).run(
        `log_${Date.now()}`,
        `Payment ${payment.id} for Order ${payment.order_id} confirmed. Receipt: ${mpesaReceiptNumber}, Amount: KSh ${paidAmount}`
      );
    } else {
      // 4. Handle Failed / Cancelled / Timeout Payment
      // ResultCode 1032 = Cancelled by user
      // ResultCode 1037 = Timeout
      // ResultCode 1 = Insufficient funds
      // ResultCode 2001 = Invalid PIN
      const finalStatus = ResultCode === 1032 ? "cancelled" : (ResultCode === 1037 ? "timeout" : "failed");

      await db.prepare(`
        UPDATE payments SET
          status = ?,
          result_code = ?,
          result_description = ?,
          raw_callback = ?,
          callback_received_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        finalStatus,
        ResultCode,
        ResultDesc,
        rawCallbackJson,
        payment.id
      );

      // Order remains unpaid (Pending), allowing customer to retry
      console.log(`M-Pesa payment ${payment.id} not completed: ${ResultDesc} (${finalStatus})`);
    }

    // Safaricom expects a 200 OK JSON response
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (err) {
    console.error("Callback processing error:", err);
    // Always acknowledge Safaricom to prevent infinite retries
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});

module.exports = router;
