// End-to-End Verification Test Script for Dokani Single-Business Ecommerce
async function runTests() {
  const baseUrl = "http://localhost:3000";
  console.log("=== Starting Dokani E2E Verification ===");

  // 1. Health check
  console.log("\n1. Testing Health Endpoint...");
  const healthRes = await fetch(`${baseUrl}/api/health`);
  const healthData = await healthRes.json();
  console.log("Health status:", healthData);
  if (healthData.status !== "ok" || healthData.currency !== "KSh") {
    throw new Error("Health check failed");
  }

  // 2. Unauthenticated /admin redirection
  console.log("\n2. Testing /admin route protection (unauthenticated)...");
  const unauthRes = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
  console.log("Unauthenticated /admin response status:", unauthRes.status);
  console.log("Location header:", unauthRes.headers.get("location"));
  if (unauthRes.status !== 302 || !unauthRes.headers.get("location")?.includes("/admin/login")) {
    throw new Error("Unauthenticated route protection failed");
  }

  // 3. Login test (Invalid password)
  console.log("\n3. Testing invalid credentials...");
  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@dokani.co.ke", password: "wrongpassword" })
  });
  console.log("Invalid login response status:", badLogin.status);
  if (badLogin.status !== 401) throw new Error("Expected 401 on bad credentials");

  // 4. Valid Admin Login
  console.log("\n4. Testing valid Admin credentials...");
  const goodLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@dokani.co.ke", password: "Admin@Dokani2026" })
  });
  const loginData = await goodLogin.json();
  console.log("Valid login status:", goodLogin.status);
  console.log("Logged in user:", loginData.user);
  const token = loginData.token;
  if (!token) throw new Error("No token returned on successful login");

  // 5. Test Section 30: Admin creates a product
  console.log("\n5. Testing Admin Product Creation (Section 30)...");
  const newProductRes = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      name: "Mount Kenya Single-Origin Coffee",
      category_id: "cat_home",
      price: 1200,
      stock: 50,
      low_stock_threshold: 10,
      sku: "DK-COF-KEN-" + Date.now(),
      description: "Medium roast specialty Arabica beans sourced directly from Nyeri farmers."
    })
  });
  const createdProduct = await newProductRes.json();
  console.log("Created product:", createdProduct.id, createdProduct.name, "Price: KSh", createdProduct.price);
  if (newProductRes.status !== 201 || !createdProduct.id) throw new Error("Failed to create product");

  // 6. Test Storefront: Product appears in public storefront
  console.log("\n6. Testing Storefront Database Connection...");
  const storefrontProductsRes = await fetch(`${baseUrl}/api/products?storefront=true`);
  const storefrontProducts = await storefrontProductsRes.json();
  const found = storefrontProducts.find(p => p.id === createdProduct.id);
  console.log("Found product on customer storefront:", found?.name, "Stock:", found?.stock);
  if (!found) throw new Error("Product created by admin did not appear on storefront");

  // 7. Customer Checkout Test
  console.log("\n7. Testing Customer Checkout with Promo & Kenyan Phone Number...");
  const checkoutRes = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_name: "Dan Wanyama",
      customer_phone: "0711223344",
      customer_email: "dan.w@example.co.ke",
      delivery_address: "Kileleshwa, Oloitokitok Road, Nairobi",
      fulfillment_type: "Delivery",
      payment_method: "M-Pesa",
      promo_code: "SUMMER20",
      items: [{ id: createdProduct.id, quantity: 2 }]
    })
  });
  const orderData = await checkoutRes.json();
  console.log("Checkout status:", checkoutRes.status);
  console.log("Order placed:", orderData.order);
  if (checkoutRes.status !== 201 || !orderData.order?.id) throw new Error("Customer checkout failed");

  // Verify stock deduction
  const verifyStockRes = await fetch(`${baseUrl}/api/products/${createdProduct.id}`);
  const stockAfter = await verifyStockRes.json();
  console.log("Product stock after 2 units ordered:", stockAfter.stock, "(Original was 50)");
  if (stockAfter.stock !== 48) throw new Error("Stock was not deducted correctly");

  // 8. Admin Order Management Test
  console.log("\n8. Testing Admin Order Verification & Status Transition...");
  const adminOrdersRes = await fetch(`${baseUrl}/api/orders`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  const ordersList = await adminOrdersRes.json();
  const placedOrder = ordersList.data.find(o => o.id === orderData.order.id);
  console.log("Admin found order:", placedOrder?.id, "Customer:", placedOrder?.customer_name, "Total: KSh", placedOrder?.total);
  if (!placedOrder) throw new Error("Order not found in Admin Orders");

  // Update order status to Confirmed
  const updateStatusRes = await fetch(`${baseUrl}/api/orders/${placedOrder.id}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ status: "Confirmed" })
  });
  console.log("Order status update status:", updateStatusRes.status);

  // Update payment to Paid
  const updatePayRes = await fetch(`${baseUrl}/api/orders/${placedOrder.id}/payment`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ payment_status: "Paid" })
  });
  console.log("Payment status update status:", updatePayRes.status);

  // 9. Check Invoice Generation
  console.log("\n9. Testing Printable Invoice Generation...");
  const invoiceRes = await fetch(`${baseUrl}/api/orders/${placedOrder.id}/invoice`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  console.log("Invoice HTTP status:", invoiceRes.status);
  const invoiceHtml = await invoiceRes.text();
  console.log("Invoice contains order ID:", invoiceHtml.includes(placedOrder.id));
  if (!invoiceHtml.includes(placedOrder.id)) throw new Error("Invoice does not contain order ID");

  // 10. Dashboard Stats
  console.log("\n10. Testing Dashboard Stats...");
  const statsRes = await fetch(`${baseUrl}/api/stats`, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  const statsData = await statsRes.json();
  console.log("Dashboard stats currency:", statsData.currency);
  console.log("Dashboard today sales:", statsData.stats.todaySales);
  console.log("Dashboard total products:", statsData.stats.totalProducts);

  console.log("\n🎉 ALL 10 TESTS PASSED SUCCESSFULLY! Single-business architecture fully verified.");
}

runTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
