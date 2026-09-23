const crypto = require("crypto");

// 32-byte encryption key derived from environment or secure server secret
const SECRET = process.env.PAYMENT_ENCRYPTION_SECRET || process.env.JWT_SECRET || "dokani-secure-daraja-encryption-key-2026";
const KEY = crypto.createHash("sha256").update(SECRET).digest();
const ALGORITHM = "aes-256-gcm";

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Output format: iv_hex:auth_tag_hex:ciphertext_hex
 */
function encrypt(plaintext) {
  if (!plaintext) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 */
function decrypt(ciphertextWithIv) {
  if (!ciphertextWithIv) return "";
  try {
    const parts = ciphertextWithIv.split(":");
    if (parts.length !== 3) return "";
    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("Decryption error:", err.message);
    return "";
  }
}

/**
 * Mask a secret string for safe presentation in admin UI (e.g., ••••••••)
 */
function maskSecret(val) {
  if (!val) return "";
  if (val.length <= 6) return "••••••";
  return `${val.substring(0, 3)}••••••••${val.substring(val.length - 3)}`;
}

module.exports = {
  encrypt,
  decrypt,
  maskSecret
};
