// Comprehensive Test Suite for Dokani M-Pesa STK Push Payment Integration
const { encrypt, decrypt, maskSecret } = require("./services/crypto");
const MpesaService = require("./services/mpesa");

async function runMpesaTests() {
  const baseUrl = "http://localhost:3000";
  console.log("==================================================================");
  console.log("  DOKANI — M-PESA STK PUSH INTEGRATION E2E TEST SUITE");
  console.log("==================================================================");

  // ── TEST 1: Encryption & Security Services ───────────────────────────────────
  console.log("\n[TEST 1] Testing AES-256-GCM Encryption, Decryption & Masking...");
  const rawSecret = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
  const encrypted = encrypt(rawSecret);
  const decrypted = decrypt(encrypted);
  const masked = maskSecret(rawSecret);

  if (encrypted === rawSecret) throw new Error("Encryption failed: output equals plaintext");
  if (decrypted !== rawSecret) throw new Error("Decryption failed: decrypted value does not match original");
  if (!masked.includes("••••••••")) throw new Error("Masking failed: does not contain masked pattern");
  console.log("  ✓ AES-256-GCM Encrypt & Decrypt verified successfully");
  console.log("  ✓ Masked presentation verified:", masked);

  // ── TEST 2: Phone Number Normalization ───────────────────────────────────────
  console.log("\n[TEST 2] Testing Kenyan Phone Number Normalization...");
  const phoneCases = [
    { input: "0712345678", expected: "254712345678" },
    { input: "0112345678", expected: "254112345678" },
    { input: "+254 712 345 678", expected: "254712345678" },
    { input: "254712345678", expected: "254712345678" },
    { input: "712345678", expected: "254712345678" },
    { input: "0712-345-678", expected: "254712345678" },
    { input: "071234567", expected: null }, // too short
    { input: "0812345678", expected: null }, // not 07/01
    { input: "abcdefghij", expected: null }
  ];

  for (const tc of phoneCases) {
    const res = MpesaService.normalizePhone(tc.input);
    if (res !== tc.expected) {
      throw new Error(`Phone normalization failed for ${tc.input}: expected ${tc.expected}, got ${res}`);
    }
  }
  console.log("  ✓ All 9 phone normalization test cases passed");

  // ── TEST 3: Admin Auth & M-Pesa Settings API ─────────────────────────────────
  console.log("\n[TEST 3] Testing Admin Auth & M-Pesa Settings Management...");
  const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@dokani.co.ke", password: "Admin@Dokani2026" })
  });
  const adminData = await adminLoginRes.json();
  const token = adminData.token;
  if (!token) throw new Error("Admin login failed");

  // 3a. GET Settings
  const getSettingsRes = await fetch(`${baseUrl}/api/admin/settings/payments/mpesa`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!getSettingsRes.ok) throw new Error(`GET M-Pesa settings failed with status ${getSettingsRes.status}`);
  const settingsData = await getSettingsRes.json();
  console.log("  ✓ Loaded M-Pesa settings:", {
    environment: settingsData.environment,
    shortcode: settingsData.shortcode,
    account_type: settingsData.account_type,
    status: settingsData.status
  });

  // 3b. PUT Settings (Update with encrypted passkey & secret)
  const putSettingsRes = await fetch(`${baseUrl}/api/admin/settings/payments/mpesa`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      environment: "sandbox",
      shortcode: "174379",
      account_type: "PayBill",
      consumer_key: "TestConsumerKey123",
      consumer_secret: "TestConsumerSecret456",
      passkey: rawSecret,
      callback_url: "https://dokani.co.ke/api/payments/mpesa/callback",
      is_enabled: true
    })
  });
  if (!putSettingsRes.ok) throw new Error("PUT M-Pesa settings failed");
  console.log("  ✓ Saved encrypted M-Pesa configuration");

  // 3c. Verify secrets are masked and never leaked
  const verifySettingsRes = await fetch(`${baseUrl}/api/admin/settings/payments/mpesa`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  const verifyData = await verifySettingsRes.json();
  if (verifyData.consumer_secret_masked !== "••••••••••••••••") {
    throw new Error("Security check failed: consumer_secret is not masked in API output");
  }
  if (verifyData.passkey_masked !== "••••••••••••••••") {
    throw new Error("Security check failed: passkey is not masked in API output");
  }
  console.log("  ✓ Zero Secrets In API Output verified (Passkey and Secret properly masked)");

  // 3d. Test Connection endpoint
  const testConnRes = await fetch(`${baseUrl}/api/admin/settings/payments/mpesa/test`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` }
  });
  const testConnData = await testConnRes.json();
  console.log("  ✓ M-Pesa Connection Test endpoint responded:", testConnData);

  // ── TEST 4: Customer Order Creation & STK Push Initiation ────────────────────
  console.log("\n[TEST 4] Testing Customer Order Creation & STK Push Initiation...");
  // 4a. Create new Order with M-Pesa payment method
  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_name: "Mwangi Kamau",
      customer_phone: "0712987654",
      customer_email: "mwangi.kamau@example.co.ke",
      delivery_address: "Koinange Street, Nairobi",
      fulfillment_type: "Delivery",
      payment_method: "M-Pesa",
      items: [{ product_id: "prod_01", quantity: 1 }]
    })
  });
  if (!orderRes.ok) {
    const err = await orderRes.text();
    throw new Error(`Order creation failed: ${err}`);
  }
  const orderData = await orderRes.json();
  const orderId = orderData.order.id;
  const orderTotal = orderData.order.total;
  console.log(`  ✓ Order created: ${orderId}, Total: KSh ${orderTotal}`);

  if (orderData.order.payment_status !== "Pending") {
    throw new Error(`Expected payment_status 'Pending', got ${orderData.order.payment_status}`);
  }
  if (orderData.order.order_status !== "Pending") {
    throw new Error(`Expected order_status 'Pending', got ${orderData.order.order_status}`);
  }
  console.log("  ✓ Initial Order & Payment status verified as strictly 'Pending'");

  // 4b. Trigger STK Push
  const stkRes = await fetch(`${baseUrl}/api/payments/mpesa/stk-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId,
      phoneNumber: "0712987654",
      simulate: true
    })
  });
  if (!stkRes.ok) {
    const err = await stkRes.text();
    throw new Error(`STK push failed: ${err}`);
  }
  const stkData = await stkRes.json();
  console.log("  ✓ STK Push initiated:", {
    paymentId: stkData.paymentId,
    checkoutRequestId: stkData.checkoutRequestId,
    phoneFormatted: stkData.phoneFormatted,
    amount: stkData.amount,
    status: stkData.status
  });

  const paymentId1 = stkData.paymentId;
  const checkoutRequestId1 = stkData.checkoutRequestId;

  // 4c. Poll status - should be pending
  const statusRes = await fetch(`${baseUrl}/api/payments/${paymentId1}/status`);
  const statusData = await statusRes.json();
  if (statusData.status !== "pending") {
    throw new Error(`Expected pending status, got ${statusData.status}`);
  }
  console.log("  ✓ Payment polling endpoint returned status: 'pending'");

  // ── TEST 5: Safaricom Webhook Callback & Idempotency ────────────────────────
  console.log("\n[TEST 5] Testing Safaricom Webhook Callback & Idempotency...");
  const mockReceipt = `NL${Math.floor(10000000 + Math.random() * 90000000)}K`;
  const callbackPayload = {
    Body: {
      stkCallback: {
        MerchantRequestID: "MR-TEST-123",
        CheckoutRequestID: checkoutRequestId1,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: orderTotal },
            { Name: "MpesaReceiptNumber", Value: mockReceipt },
            { Name: "TransactionDate", Value: "20260917123000" },
            { Name: "PhoneNumber", Value: 254712987654 }
          ]
        }
      }
    }
  };

  // 5a. Post Callback to webhook endpoint
  const cbRes = await fetch(`${baseUrl}/api/payments/mpesa/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(callbackPayload)
  });
  const cbData = await cbRes.json();
  if (cbData.ResultCode !== 0) throw new Error("Callback webhook rejected");
  console.log("  ✓ Callback webhook acknowledged:", cbData);

  // 5b. Verify Payment updated to 'paid' and order updated to 'Paid' / 'Processing'
  const verifyPayStatus = await fetch(`${baseUrl}/api/payments/${paymentId1}/status`);
  const verifyPayData = await verifyPayStatus.json();
  if (verifyPayData.status !== "paid") {
    throw new Error(`Expected payment status 'paid', got ${verifyPayData.status}`);
  }
  if (verifyPayData.receiptNumber !== mockReceipt) {
    throw new Error(`Expected receipt ${mockReceipt}, got ${verifyPayData.receiptNumber}`);
  }
  if (verifyPayData.orderStatus !== "Processing") {
    throw new Error(`Expected orderStatus 'Processing', got ${verifyPayData.orderStatus}`);
  }
  console.log("  ✓ Payment status verified as 'paid' with M-Pesa Receipt:", verifyPayData.receiptNumber);

  // 5c. Test IDEMPOTENCY: Send identical callback again
  const cbRes2 = await fetch(`${baseUrl}/api/payments/mpesa/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(callbackPayload)
  });
  const cbData2 = await cbRes2.json();
  if (cbData2.ResultDesc !== "Already processed") {
    throw new Error(`Idempotency check failed: expected 'Already processed', got '${cbData2.ResultDesc}'`);
  }
  console.log("  ✓ Idempotency verified: duplicate callback gracefully returned 'Already processed'");

  // ── TEST 6: Payment Failure, Cancellation & Retry ───────────────────────────
  console.log("\n[TEST 6] Testing Payment Failure, Cancellation & Retry Logic...");
  // 6a. Create second order
  const order2Res = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_name: "Amina Hassan",
      customer_phone: "0722112233",
      payment_method: "M-Pesa",
      items: [{ product_id: "prod_02", quantity: 1 }]
    })
  });
  const order2Data = await order2Res.json();
  const order2Id = order2Data.order.id;

  // 6b. Initiate STK Push
  const stk2Res = await fetch(`${baseUrl}/api/payments/mpesa/stk-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: order2Id,
      phoneNumber: "0722112233",
      simulate: true
    })
  });
  const stk2Data = await stk2Res.json();
  const payment2Id = stk2Data.paymentId;
  const checkoutRequest2Id = stk2Data.checkoutRequestId;

  // 6c. Simulate User Cancellation Callback (ResultCode 1032)
  const cancelPayload = {
    Body: {
      stkCallback: {
        MerchantRequestID: "MR-TEST-456",
        CheckoutRequestID: checkoutRequest2Id,
        ResultCode: 1032,
        ResultDesc: "[MDS] Request cancelled by user"
      }
    }
  };
  await fetch(`${baseUrl}/api/payments/mpesa/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cancelPayload)
  });

  // Verify payment 2 is cancelled
  const checkCancelRes = await fetch(`${baseUrl}/api/payments/${payment2Id}/status`);
  const checkCancelData = await checkCancelRes.json();
  if (checkCancelData.status !== "cancelled") {
    throw new Error(`Expected payment status 'cancelled', got ${checkCancelData.status}`);
  }
  console.log("  ✓ User cancellation (1032) recorded payment status as 'cancelled'");

  // 6d. Test Retry endpoint for the same order
  const retryRes = await fetch(`${baseUrl}/api/payments/mpesa/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: order2Id,
      phoneNumber: "0722112233",
      simulate: true
    })
  });
  if (!retryRes.ok) throw new Error("Retry request failed");
  const retryData = await retryRes.json();
  if (retryData.orderId !== order2Id || retryData.status !== "pending") {
    throw new Error("Retry STK push failed to generate pending retry payment");
  }
  console.log("  ✓ Payment retry successfully generated new pending STK attempt for order", order2Id);

  // ── TEST 7: Admin Payments API, Filters & Statistics ─────────────────────────
  console.log("\n[TEST 7] Testing Admin Payment Transactions API & Analytics...");
  // 7a. GET /api/admin/payments/stats
  const statsRes = await fetch(`${baseUrl}/api/admin/payments/stats`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!statsRes.ok) throw new Error(`Stats endpoint failed with status ${statsRes.status}`);
  const stats = await statsRes.json();
  console.log("  ✓ Admin Payment Stats:", stats);
  if (stats.successCount < 1) throw new Error("Stats successCount expected >= 1");
  if (stats.totalRevenue <= 0) throw new Error("Stats totalRevenue expected > 0");

  // 7b. GET /api/admin/payments (All list)
  const listRes = await fetch(`${baseUrl}/api/admin/payments?limit=10`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!listRes.ok) throw new Error("Admin payments list failed");
  const listData = await listRes.json();
  console.log(`  ✓ Admin Payments List returned ${listData.total} total transactions`);
  if (!listData.data || listData.data.length === 0) {
    throw new Error("Expected payments list to return transactions");
  }

  // 7c. GET /api/admin/payments/:id (Single detail)
  const detailRes = await fetch(`${baseUrl}/api/admin/payments/${paymentId1}`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!detailRes.ok) throw new Error("Admin payment detail failed");
  const detailData = await detailRes.json();
  console.log("  ✓ Admin Payment Detail retrieved successfully:", {
    id: detailData.id,
    order_id: detailData.order_id,
    amount: detailData.amount,
    status: detailData.status,
    receipt: detailData.mpesa_receipt_number,
    has_audit_logs: Boolean(detailData.audit_logs?.length)
  });

  // ── TEST 8: Customer Manual Cancel & Cash on Delivery Fallback ──────────────
  console.log("\n[TEST 8] Testing Customer Manual Cancel & Cash on Delivery Fallback...");
  // 8a. Manual cancel pending payment
  const cancelRes = await fetch(`${baseUrl}/api/payments/mpesa/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentId: retryData.paymentId, orderId: order2Id })
  });
  if (!cancelRes.ok) throw new Error("Manual cancel request failed");
  const cancelData = await cancelRes.json();
  if (!cancelData.success) throw new Error("Manual cancel failed");
  console.log("  ✓ Customer manual cancellation endpoint successful");

  // 8b. Switch to Cash on Delivery
  const switchRes = await fetch(`${baseUrl}/api/payments/switch-to-cod`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order2Id })
  });
  if (!switchRes.ok) throw new Error("Switch to COD failed");
  const switchData = await switchRes.json();
  if (switchData.order.payment_method !== "Cash on Delivery") {
    throw new Error("Expected payment_method to be Cash on Delivery");
  }
  console.log("  ✓ Switch to Cash on Delivery successful for order", order2Id);

  console.log("\n==================================================================");
  console.log("  ✓ ALL DOKANI M-PESA STK PUSH INTEGRATION TESTS PASSED!");
  console.log("==================================================================\n");
}

runMpesaTests().catch(err => {
  console.error("\n❌ M-Pesa Test Suite Error:", err);
  process.exit(1);
});
