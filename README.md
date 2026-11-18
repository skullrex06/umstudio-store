# UMstudio — Hybrid-ready digital e-commerce starter

This project is a deployable **digital-download-only** storefront for worldwide customers, with USD pricing. It uses Cloudflare Workers + D1 + private R2 object storage + Stripe Checkout.

## What's included
- Responsive customer storefront and searchable product catalogue
- Customer registration/login (PBKDF2 password hashing, random session cookie, hashed session tokens)
- Shopping cart and Stripe-hosted checkout
- Stripe webhook verification and paid-order entitlements
- Private R2-backed downloads with per-entitlement download limits
- Customer order history and download library
- Admin role and summary endpoint
- D1 schema and migration

## Important: not live until configured
No Cloudflare account, domain, Stripe account, API secrets, R2 bucket, or production admin has been connected from this chat. This is application source, not a deployed store. The checkout will not accept money until Stripe and webhook secrets are configured. The example storefront contains no live products.

## Prerequisites
- Cloudflare account with Workers, D1 and R2
- Node.js and Wrangler CLI
- Stripe account enabled for your business country
- A domain with HTTPS
- Optional email/support address and privacy/terms/refund policy

## 1. Install and create resources
```bash
npm install -g wrangler
wrangler login
wrangler d1 create umstudio-db
wrangler r2 bucket create umstudio-private-files
```
Copy the D1 `database_id` into `wrangler.toml`. Create a private R2 bucket; do not enable public access.

## 2. Configure bindings and secrets
The `FILES` R2 binding is already included in `wrangler.toml`. Create the bucket with the exact name shown there. Set `SITE_URL` to the exact HTTPS origin, e.g. `https://shop.yourdomain.com`.

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

## 3. Apply the database migration
```bash
wrangler d1 migrations apply umstudio-db --remote
```

## 4. Deploy
```bash
wrangler deploy
```
Workers serves the static storefront from `public/` and the API from `/api/*`.

## 5. Create the first admin safely
Register your own account using the storefront. Then promote that exact email using a one-time SQL command:
```bash
wrangler d1 execute umstudio-db --remote --command "UPDATE users SET role='admin' WHERE email='YOUR-ADMIN-EMAIL';"
```
Use a strong unique password (12+ characters). Do not expose admin credentials in frontend code. For production, add rate limiting, account recovery, MFA, audit logs and stricter admin authorization.

## 6. Upload digital files and add products
Upload files to private R2:
```bash
wrangler r2 object put umstudio-private-files/products/sample-guide.pdf --file ./sample-guide.pdf
```
Use the authenticated admin endpoint to create a product:
```bash
curl -X POST 'https://YOUR-DOMAIN/api/admin/products' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: um_session=YOUR_ADMIN_SESSION_COOKIE' \
  --data '{"name":"Sample Guide","slug":"sample-guide","description":"A practical downloadable guide.","price":9.99,"file_key":"products/sample-guide.pdf","cover_url":""}'
```
The admin API also accepts multipart uploads at `/api/admin/upload` (maximum 25 MB) and returns a private R2 object key. Keep R2 keys private.

## 7. Configure Stripe webhook
In Stripe Dashboard, add endpoint:
`https://YOUR-DOMAIN/api/webhooks/stripe`

Subscribe to:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`

Copy the endpoint signing secret to `STRIPE_WEBHOOK_SECRET`.

## 8. Production checklist
- Set the correct `SITE_URL`, custom domain and HTTPS.
- Verify Stripe business-country eligibility, supported customer payment methods, taxes and payout bank details.
- Configure Stripe tax if required for your sales jurisdictions; obtain professional tax advice for VAT/GST/sales-tax obligations.
- Add privacy policy, terms of sale, refund policy, contact details and digital-content licence terms.
- Add transactional email (receipts, download-ready notifications, password reset) using a trusted email provider.
- Add bot protection/rate limiting and security monitoring.
- Test successful, declined, abandoned, refunded and duplicate webhook events using Stripe test mode.
- Test downloads and ensure the R2 bucket is private.

## Known scope / security notes
This is a starter foundation, not a certified turnkey commerce platform. Customer passwords are PBKDF2-hashed and sessions are stored hashed, but the starter does not yet include email verification, password reset, MFA, rate limiting, tax calculation, automated refunds, email notifications, coupon codes, multi-currency display, or a full admin file-upload/catalogue UI. Add these before a public launch. Digital download access is granted only after a verified Stripe payment webhook.

### Admin upload endpoint
```bash
curl -X POST 'https://YOUR-DOMAIN/api/admin/upload' \
  -H 'Cookie: um_session=YOUR_ADMIN_SESSION_COOKIE' \
  -F 'file=@./sample-guide.pdf'
```
Use the returned `key` as `file_key` in the product creation request above.
