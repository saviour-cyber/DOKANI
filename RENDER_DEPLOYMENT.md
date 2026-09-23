# Dokani Single-Business Ecommerce — Render Deployment Guide

This guide explains how to deploy **Dokani Ecommerce** to **[Render.com](https://render.com)** connected to your live **TiDB Cloud** database.

---

## 🚀 Quick Setup (Overview)

* **Build Command:** `npm install`
* **Start Command:** `npm start`
* **Node Version:** `20.x` or higher (configured in `package.json`)
* **Health Check Path:** `/api/health`
* **Database:** TiDB Cloud Serverless (already migrated and verified)

---

## Step 1: Push Code to GitHub

If your project is not yet in a GitHub repository:

```bash
git init
git add .
git commit -m "Dokani single-business ecommerce with TiDB Cloud"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo-name>.git
git push -u origin main
```

*(Note: `.env` and `*.db` are already in `.gitignore`, so your local database and credentials are safe and won't be pushed to GitHub).*

---

## Step 2: Deploy on Render

### Method A: 1-Click Blueprint (Recommended)

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub repository.
4. Render will read [`render.yaml`](./render.yaml) automatically.
5. In the prompts, enter your `TIDB_PASSWORD`:
   * **Value:** `UeBXo6eekxFj7Wsl`
6. Click **Apply**. Render will automatically build and launch your application!

---

### Method B: Manual Web Service

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** → **Web Service**.
3. Connect your GitHub repository.
4. Configure the settings:
   * **Name:** `dokani-ecommerce` (or your choice)
   * **Region:** Frankfurt (EU) or Oregon (US)
   * **Branch:** `main`
   * **Runtime:** `Node`
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
   * **Instance Type:** `Free` (or Starter for 24/7 uptime)

5. Under **Advanced** → **Health Check Path**:
   * Enter `/api/health`

6. Under **Environment Variables**, add the following:

| Key | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables production caching & secure cookies |
| `TIDB_HOST` | `gateway01.ap-northeast-1.prod.aws.tidbcloud.com` | TiDB Cloud Gateway |
| `TIDB_PORT` | `4000` | TiDB Cloud Port |
| `TIDB_USER` | `4WejAStBArqicGX.root` | TiDB Cloud User |
| `TIDB_PASSWORD` | `UeBXo6eekxFj7Wsl` | TiDB Cluster Password |
| `TIDB_DATABASE` | `dokani` | Production Database |
| `TIDB_ENABLE_SSL` | `true` | Required for TiDB Cloud TLS |
| `JWT_SECRET` | *(Generate a 32+ character random string)* | Used for Admin auth |
| `CUSTOMER_JWT_SECRET`| *(Generate a 32+ character random string)* | Used for Customer portal auth |
| `PAYMENT_ENCRYPTION_SECRET` | *(Generate a 32+ character random string)* | Used for AES-256 M-Pesa secrets |

7. Click **Create Web Service**.

---

## Step 3: Verify Your Deployment

Once Render finishes the build (usually takes ~1–2 minutes):

1. **Storefront:** `https://<your-service-name>.onrender.com/store`
2. **Customer Portal:** `https://<your-service-name>.onrender.com/store/account`
3. **Admin Dashboard:** `https://<your-service-name>.onrender.com/admin`
4. **Health Check:** `https://<your-service-name>.onrender.com/api/health`

---

## Step 4: Safaricom Daraja M-Pesa Webhook Setup

Once your Render URL is live (e.g. `https://dokani-ecommerce.onrender.com`):

1. Log into your **Admin Portal** at `/admin`.
2. Go to **Settings** → **Payments (M-Pesa)**.
3. Update the **Callback URL** to:
   ```
   https://<your-service-name>.onrender.com/api/payments/mpesa/callback
   ```
4. Save the configuration. Your M-Pesa STK push callbacks will now be received directly in production!
