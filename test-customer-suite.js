const http = require("http");

const BASE = "http://localhost:3000";

async function request(path, options = {}) {
  const url = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const headers = options.headers || {};
    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
    }

    const req = http.request(url, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json || data
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'object' ? JSON.stringify(options.body) : options.body);
    }
    req.end();
  });
}

function extractCookie(headers, cookieName) {
  const setCookies = headers['set-cookie'];
  if (!setCookies) return null;
  for (const c of setCookies) {
    if (c.startsWith(`${cookieName}=`)) {
      return c.split(';')[0].split('=')[1];
    }
  }
  return null;
}

async function runTests() {
  console.log("=================================================================");
  console.log("  DOKANI — CUSTOMER PORTAL & AUTHENTICATION VERIFICATION SUITE  ");
  console.log("=================================================================\n");

  let passed = 0;
  let total = 0;

  function assert(condition, testName) {
    total++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
    }
  }

  try {
    // 1. Web route check: unauthenticated /store/account redirects to login
    const accWebUnauth = await request("/store/account");
    assert(accWebUnauth.status === 302 && accWebUnauth.headers.location.includes("/store/login"), "1. Unauthenticated /store/account redirects to /store/login");

    // 2. Web route check: public customer auth pages return 200
    const loginPage = await request("/store/login");
    const regPage = await request("/store/register");
    const forgotPage = await request("/store/forgot-password");
    assert(loginPage.status === 200 && regPage.status === 200 && forgotPage.status === 200, "2. Customer auth web routes (/store/login, /register, /forgot-password) return 200");

    // 3. Customer Registration validation
    const invalidPhoneRes = await request("/api/customer/auth/register", {
      method: "POST",
      body: { name: "Test User", phone: "12345", email: "test@example.co.ke", password: "Password123", confirmPassword: "Password123" }
    });
    assert(invalidPhoneRes.status === 400, "3. Registration rejects invalid phone number");

    const mismatchPassRes = await request("/api/customer/auth/register", {
      method: "POST",
      body: { name: "Test User", phone: "0711998877", email: "mismatch@example.co.ke", password: "Password123", confirmPassword: "DifferentPassword" }
    });
    assert(mismatchPassRes.status === 400, "4. Registration rejects mismatched password confirmation");

    // 4. Valid Customer Registration
    const testEmail = `amina.test.${Date.now()}@example.co.ke`;
    const testPhone = `0712${Math.floor(100000 + Math.random() * 900000)}`;
    const regRes = await request("/api/customer/auth/register", {
      method: "POST",
      body: {
        name: "Amina Hassan Test",
        phone: testPhone,
        email: testEmail,
        password: "Customer@2026",
        confirmPassword: "Customer@2026"
      }
    });
    const regCookie = extractCookie(regRes.headers, "dokani_customer_token");
    assert(regRes.status === 201 && regRes.data.account && regCookie, "5. Successful customer registration sets dokani_customer_token cookie");

    // 5. Duplicate email registration rejected
    const dupRes = await request("/api/customer/auth/register", {
      method: "POST",
      body: {
        name: "Duplicate User",
        phone: `0722${Math.floor(100000 + Math.random() * 900000)}`,
        email: testEmail,
        password: "Customer@2026",
        confirmPassword: "Customer@2026"
      }
    });
    assert(dupRes.status === 400 && dupRes.data.error.includes("already exists"), "6. Duplicate email registration is prevented with clear message");

    // 6. Customer Login via Email
    const loginEmailRes = await request("/api/customer/auth/login", {
      method: "POST",
      body: { identifier: testEmail, password: "Customer@2026" }
    });
    const customerToken = loginEmailRes.data.token;
    assert(loginEmailRes.status === 200 && customerToken, "7. Customer logs in successfully using email & password");

    // 7. Customer Login via Phone Number
    const loginPhoneRes = await request("/api/customer/auth/login", {
      method: "POST",
      body: { identifier: testPhone, password: "Customer@2026" }
    });
    assert(loginPhoneRes.status === 200, "8. Customer logs in successfully using phone number & password");

    // 8. Invalid customer credentials
    const badLoginRes = await request("/api/customer/auth/login", {
      method: "POST",
      body: { identifier: testEmail, password: "WrongPassword" }
    });
    assert(badLoginRes.status === 401, "9. Invalid customer login credentials return 401");

    // 9. Cross-Authentication Isolation Check:
    // Customer token can NEVER access Admin endpoints
    const adminStatsRes = await request("/api/stats", {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert(adminStatsRes.status === 401, "10. Customer token is rejected on Admin API (/api/stats -> 401)");

    const adminWebRes = await request("/admin", {
      headers: { Cookie: `dokani_customer_token=${customerToken}` }
    });
    assert(adminWebRes.status === 302 && adminWebRes.headers.location.includes("/admin/login"), "11. Customer cookie cannot access /admin portal (redirects to /admin/login)");

    // 10. Customer Session Verification (GET /api/customer/auth/me)
    const meRes = await request("/api/customer/auth/me", {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert(meRes.status === 200 && meRes.data.account.email === testEmail, "12. Customer /me endpoint returns authenticated profile");

    // 11. Customer Profile Update
    const updateProfileRes = await request("/api/customer/auth/profile", {
      method: "PUT",
      headers: { Authorization: `Bearer ${customerToken}` },
      body: {
        name: "Amina Hassan Updated",
        phone: testPhone,
        address: "Links Road, Nyali, Mombasa, Kenya"
      }
    });
    assert(updateProfileRes.status === 200 && updateProfileRes.data.account.name === "Amina Hassan Updated", "13. Customer profile and delivery address updated");

    // 12. Wishlist operations
    const addWishRes = await request("/api/customer/wishlist", {
      method: "POST",
      headers: { Authorization: `Bearer ${customerToken}` },
      body: { product_id: "prod_01" }
    });
    assert(addWishRes.status === 201, "14. Product added to customer wishlist");

    const getWishRes = await request("/api/customer/wishlist", {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const hasProd1 = Array.isArray(getWishRes.data) && getWishRes.data.some(i => i.id === "prod_01");
    assert(hasProd1, "15. Customer wishlist query returns saved product with details");

    const delWishRes = await request("/api/customer/wishlist/prod_01", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert(delWishRes.status === 200, "16. Product removed from customer wishlist");

    // 13. Customer Checkout while Authenticated
    const orderRes = await request("/api/orders", {
      method: "POST",
      headers: { Cookie: `dokani_customer_token=${customerToken}` },
      body: {
        customer_name: "Amina Hassan Updated",
        customer_phone: testPhone,
        customer_email: testEmail,
        delivery_address: "Links Road, Nyali, Mombasa, Kenya",
        fulfillment_type: "Delivery",
        payment_method: "M-Pesa",
        items: [{ id: "prod_02", quantity: 1 }] // Leather Backpack
      }
    });
    const orderId = orderRes.data?.order?.id;
    assert(orderRes.status === 201 && orderId, "17. Authenticated customer checkout creates order tied to customer");

    // 14. Customer My Orders
    const myOrdersRes = await request("/api/customer/orders", {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const hasNewOrder = Array.isArray(myOrdersRes.data) && myOrdersRes.data.some(o => o.id === orderId);
    assert(hasNewOrder, "18. Customer can view their order history in /api/customer/orders");

    // 15. Customer Order Detail
    const orderDetailRes = await request(`/api/customer/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert(orderDetailRes.status === 200 && orderDetailRes.data.id === orderId && orderDetailRes.data.items.length > 0, "19. Customer can view full order receipt and item breakdown");

    // 16. Customer Reorder
    const reorderRes = await request(`/api/customer/orders/${orderId}/reorder`, {
      method: "POST",
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    assert(reorderRes.status === 200 && reorderRes.data.items.length > 0, "20. Reorder endpoint returns order items ready for cart");

    // 17. Change Password
    const changePassRes = await request("/api/customer/auth/password", {
      method: "PUT",
      headers: { Authorization: `Bearer ${customerToken}` },
      body: {
        currentPassword: "Customer@2026",
        newPassword: "NewCustomer@2026",
        confirmPassword: "NewCustomer@2026"
      }
    });
    assert(changePassRes.status === 200, "21. Customer successfully updates password");

    // 18. Login with new password
    const loginNewPassRes = await request("/api/customer/auth/login", {
      method: "POST",
      body: { identifier: testEmail, password: "NewCustomer@2026" }
    });
    assert(loginNewPassRes.status === 200, "22. Customer can log in with new password");

    // 19. Customer Logout
    const logoutRes = await request("/api/customer/auth/logout", { method: "POST" });
    assert(logoutRes.status === 200, "23. Customer logout clears session cookie");

    console.log("\n=================================================================");
    console.log(`  RESULT: ${passed} / ${total} TESTS PASSED`);
    console.log("=================================================================");

    if (passed === total) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error("Test execution error:", err);
    process.exit(1);
  }
}

runTests();
