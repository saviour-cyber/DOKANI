const { db } = require("../db");
const { encrypt, decrypt } = require("./crypto");

class MpesaService {
  /**
   * Normalize any Kenyan phone number to 254XXXXXXXXX (12 digits)
   */
  static normalizePhone(phone) {
    if (!phone) return null;
    let p = String(phone).replace(/[\s\-\(\)\+]/g, "");
    if (p.startsWith("07") || p.startsWith("01")) {
      p = `254${p.substring(1)}`;
    } else if (p.startsWith("7") || p.startsWith("1")) {
      if (p.length === 9) p = `254${p}`;
    }
    if (!/^254(7|1)\d{8}$/.test(p)) {
      return null;
    }
    return p;
  }

  /**
   * Format phone for display with masking (e.g. 0712 *** 456)
   */
  static formatPhoneMasked(phone) {
    if (!phone) return "";
    const clean = String(phone).replace(/[\s\-\(\)\+]/g, "");
    let local = clean;
    if (clean.startsWith("254") && clean.length === 12) {
      local = "0" + clean.substring(3);
    }
    if (local.length === 10) {
      return `${local.substring(0, 4)} *** ${local.substring(7)}`;
    }
    return local;
  }

  /**
   * Load M-Pesa configuration from database, falling back to environment variables
   */
  static async getConfig() {
    let settings = null;
    try {
      settings = await db.prepare("SELECT * FROM payment_settings WHERE key = 'mpesa'").get();
    } catch (e) {}

    const environment = settings?.environment || process.env.MPESA_ENVIRONMENT || "sandbox";
    const shortcode = settings?.shortcode || process.env.MPESA_SHORTCODE || "174379";
    const accountType = settings?.account_type || "PayBill";
    const callbackUrl = settings?.callback_url || process.env.MPESA_CALLBACK_URL || "https://dokani.co.ke/api/payments/mpesa/callback";
    const isEnabled = settings?.is_enabled !== undefined ? Boolean(settings.is_enabled) : true;

    // Retrieve and decrypt keys
    let consumerKey = settings?.consumer_key || process.env.MPESA_CONSUMER_KEY || "";
    let consumerSecret = "";
    let passkey = "";

    if (settings?.consumer_secret_encrypted) {
      consumerSecret = decrypt(settings.consumer_secret_encrypted);
    } else if (process.env.MPESA_CONSUMER_SECRET) {
      consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    }

    if (settings?.passkey_encrypted) {
      passkey = decrypt(settings.passkey_encrypted);
    } else if (process.env.MPESA_PASSKEY) {
      passkey = process.env.MPESA_PASSKEY;
    }

    // Default Daraja Sandbox passkey if in sandbox and not explicitly set
    if (!passkey && environment === "sandbox") {
      passkey = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
    }

    const baseUrl = environment === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

    return {
      environment,
      shortcode,
      accountType,
      callbackUrl,
      isEnabled,
      consumerKey,
      consumerSecret,
      passkey,
      baseUrl
    };
  }

  /**
   * Get East Africa Time (EAT / UTC+3) timestamp formatted as YYYYMMDDHHmmss
   */
  static getTimestamp() {
    const now = new Date();
    // Offset for UTC+3
    const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
    const eatDate = new Date(utcTime + 3 * 3600000);

    const pad = n => String(n).padStart(2, "0");
    const yyyy = eatDate.getFullYear();
    const MM = pad(eatDate.getMonth() + 1);
    const dd = pad(eatDate.getDate());
    const hh = pad(eatDate.getHours());
    const mm = pad(eatDate.getMinutes());
    const ss = pad(eatDate.getSeconds());

    return `${yyyy}${MM}${dd}${hh}${mm}${ss}`;
  }

  /**
   * Generate Daraja STK Push password: base64(Shortcode + Passkey + Timestamp)
   */
  static generatePassword(shortcode, passkey, timestamp) {
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  }

  /**
   * Request OAuth Access Token from Safaricom Daraja
   */
  static async getAccessToken(config = null) {
    const conf = config || await this.getConfig();
    if (!conf.consumerKey || !conf.consumerSecret) {
      throw new Error("M-Pesa Consumer Key and Consumer Secret are required.");
    }

    const auth = Buffer.from(`${conf.consumerKey.trim()}:${conf.consumerSecret.trim()}`).toString("base64");
    const url = `${conf.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      let errorMsg = `Daraja OAuth Error (HTTP ${res.status})`;
      try {
        const errJson = JSON.parse(errText);
        errorMsg = errJson.errorMessage || errJson.error_description || errorMsg;
      } catch (e) {}
      throw new Error(errorMsg);
    }

    const data = await res.json();
    return data.access_token;
  }

  /**
   * Test connection to Safaricom Daraja using current credentials
   */
  static async testConnection() {
    const conf = await this.getConfig();

    if (!conf.consumerKey || !conf.consumerSecret) {
      return {
        success: false,
        error: "Consumer Key and Consumer Secret are missing. Please enter your credentials."
      };
    }

    try {
      const token = await this.getAccessToken(conf);
      const isLive = Boolean(token && token.length > 5);

      // Record test status in DB
      try {
        await db.prepare(`
          UPDATE payment_settings
          SET last_tested_at = CURRENT_TIMESTAMP,
              last_test_status = ?
          WHERE key = 'mpesa'
        `).run(isLive ? "Connected" : "Configuration Error");
      } catch (e) {}

      return {
        success: true,
        message: "M-Pesa connection successful",
        environment: conf.environment,
        shortcode: conf.shortcode,
        status: "Connected"
      };
    } catch (err) {
      try {
        await db.prepare(`
          UPDATE payment_settings
          SET last_tested_at = CURRENT_TIMESTAMP,
              last_test_status = 'Configuration Error'
          WHERE key = 'mpesa'
        `).run();
      } catch (e) {}

      return {
        success: false,
        error: `Unable to connect to M-Pesa: ${err.message}`
      };
    }
  }

  /**
   * Initiate STK Push (Lipa Na M-Pesa Online)
   * @param {Object} params
   * @param {string} params.orderId
   * @param {string} params.phoneNumber
   * @param {number} params.amount
   * @param {boolean} [params.simulate] - for automated testing / dev mock
   */
  static async initiateSTKPush({ orderId, phoneNumber, amount, simulate = false }) {
    const normalizedPhone = this.normalizePhone(phoneNumber);
    if (!normalizedPhone) {
      throw new Error("Invalid Kenyan phone number. Use format 07XXXXXXXX or 01XXXXXXXX.");
    }

    const conf = await this.getConfig();
    const finalAmount = Math.max(1, Math.round(amount));
    const timestamp = this.getTimestamp();
    const password = this.generatePassword(conf.shortcode, conf.passkey, timestamp);

    // If simulation is requested or in automated test mock mode without live Daraja credentials
    const isMock = simulate || (!conf.consumerKey && process.env.NODE_ENV !== "production");

    if (isMock) {
      const merchantReqId = `MR-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const checkoutReqId = `ws_CO_${Date.now()}_${Math.floor(100000 + Math.random() * 900000)}`;
      return {
        success: true,
        merchantRequestId: merchantReqId,
        checkoutRequestId: checkoutReqId,
        responseCode: "0",
        responseDescription: "Success. Request accepted for processing",
        customerMessage: "Success. Request accepted for processing",
        phone: normalizedPhone,
        amount: finalAmount,
        isSimulated: true
      };
    }

    // Real Daraja API call
    const accessToken = await this.getAccessToken(conf);
    const url = `${conf.baseUrl}/mpesa/stkpush/v1/processrequest`;

    const txType = conf.accountType === "Till" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";

    const payload = {
      BusinessShortCode: conf.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: txType,
      Amount: finalAmount,
      PartyA: normalizedPhone,
      PartyB: conf.shortcode,
      PhoneNumber: normalizedPhone,
      CallBackURL: conf.callbackUrl,
      AccountReference: orderId,
      TransactionDesc: `Dokani Order ${orderId}`
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok || data.ResponseCode !== "0") {
      const errMsg = data.errorMessage || data.ResponseDescription || `STK Push Failed (Code ${data.ResponseCode || res.status})`;
      throw new Error(errMsg);
    }

    return {
      success: true,
      merchantRequestId: data.MerchantRequestID,
      checkoutRequestId: data.CheckoutRequestID,
      responseCode: data.ResponseCode,
      responseDescription: data.ResponseDescription,
      customerMessage: data.CustomerMessage,
      phone: normalizedPhone,
      amount: finalAmount,
      isSimulated: false
    };
  }

  /**
   * Query STK Push Transaction Status directly from Safaricom Daraja
   * @param {string} checkoutRequestId
   */
  static async querySTKStatus(checkoutRequestId) {
    if (!checkoutRequestId) return null;
    const conf = await this.getConfig();
    if (!conf.consumerKey || !conf.consumerSecret) return null;

    try {
      const accessToken = await this.getAccessToken(conf);
      const timestamp = this.getTimestamp();
      const password = this.generatePassword(conf.shortcode, conf.passkey, timestamp);
      const url = `${conf.baseUrl}/mpesa/stkpushquery/v1/query`;

      const payload = {
        BusinessShortCode: conf.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        return null;
      }

      const data = await res.json();
      return data;
    } catch (err) {
      console.warn("Daraja STK Query notice:", err.message);
      return null;
    }
  }
}

module.exports = MpesaService;
