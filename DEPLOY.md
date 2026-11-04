# Deploying TailorCV

You need three accounts before you start: a host (Render is the easiest), [Stripe](https://dashboard.stripe.com) and [Anthropic](https://console.anthropic.com). The whole thing takes about 30 minutes.

## 1. Get your keys

**Anthropic API key**

1. Go to https://console.anthropic.com, open **API Keys** and click **Create Key**.
2. Copy it. It starts with `sk-ant-`. You only see it once.
3. Add a payment method under **Billing**, otherwise requests fail once the free credit is used.

**Stripe secret key**

1. Go to https://dashboard.stripe.com/apikeys.
2. Copy the **Secret key**. Use the test key (`sk_test_...`) first. Switch to the live key (`sk_live_...`) once the test order in the checklist below works.

**Admin token**

Make up a long random string, for example `openssl rand -hex 32`. You will send it as a bearer token to `/api/admin/stats`.

## 2. Deploy on Render (recommended)

The repo ships a `render.yaml` blueprint. It creates one web service on the Starter plan with a 1 GB disk at `/data`, so orders survive redeploys.

1. Push the repo to GitHub.
2. In the Render dashboard click **New > Blueprint**, pick the repo and click **Connect**.
3. Render reads `render.yaml` and asks for the values marked `sync: false`. Fill them in:
   - `ANTHROPIC_API_KEY`: from step 1.
   - `STRIPE_SECRET_KEY`: your `sk_test_...` key for now.
   - `STRIPE_WEBHOOK_SECRET`: leave blank for the moment; you get it in step 3.
   - `BASE_URL`: the public URL of the service, `https://tailorcv.onrender.com` or similar. Render shows the name on this screen; it is `https://<service-name>.onrender.com`. No trailing slash.
   - `ADMIN_TOKEN`: the random string from step 1.
4. Click **Apply**. The first build takes two or three minutes. When the health check at `/` passes, the service is live.
5. Open `BASE_URL` in a browser. You should see the TailorCV page.

To redeploy, push to `main`. Render builds and swaps the service automatically.

## 3. Stripe webhook

Stripe tells the server an order is paid through a webhook. Without it, orders only run while the buyer keeps the result page open.

1. Go to https://dashboard.stripe.com/webhooks (stay in **Test mode** while you use the test key) and click **Add endpoint**.
2. Endpoint URL: `https://YOUR-DOMAIN/api/stripe/webhook` (your `BASE_URL` plus `/api/stripe/webhook`).
3. Under **Select events**, pick `checkout.session.completed`. Nothing else is needed.
4. Click **Add endpoint**, then click **Reveal** under **Signing secret**. It starts with `whsec_`.
5. In Render, open the service, go to **Environment**, set `STRIPE_WEBHOOK_SECRET` to that value and save. Render restarts the service.
6. Repeat this once more in **Live mode** when you switch to the live Stripe key. Live mode has its own endpoint and its own signing secret.

## 4. Custom domain

1. In Render open the service, go to **Settings > Custom Domains** and add your domain, for example `tailorcv.example.com`.
2. Add the CNAME (or A record for a bare domain) Render shows you at your DNS provider. Render issues the TLS certificate once DNS resolves, usually within a few minutes.
3. Change `BASE_URL` in **Environment** to `https://tailorcv.example.com`. Stripe redirects buyers back to this URL after payment, so it must match the domain they visit.
4. Update the Stripe webhook endpoint URL to the new domain (or add a second endpoint). The signing secret stays the same for an edited endpoint.
5. Replace `YOURDOMAIN.com` and `support@YOURDOMAIN.com` in `public/` and redeploy.

## Other hosts

### Fly.io

`fly.toml` is included. It builds from the `Dockerfile`, keeps one machine running in `iad` and mounts a 1 GB volume at `/data`.

```bash
fly launch --copy-config --no-deploy   # pick a unique app name when asked; it replaces "tailorcv"
fly volumes create data --region iad --size 1
fly secrets set ANTHROPIC_API_KEY=sk-ant-... STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... ADMIN_TOKEN=... BASE_URL=https://<app>.fly.dev
fly deploy
```

Then do the Stripe webhook steps in section 3 with the Fly URL. For a custom domain: `fly certs add tailorcv.example.com`, add the DNS records it prints and update `BASE_URL` with `fly secrets set`.

### Railway

`railway.json` is included (Nixpacks build, `npm start`, restarts on failure).

1. **New Project > Deploy from GitHub repo**, pick the repo.
2. In the service, open **Variables** and add `NODE_ENV=production`, `DATA_DIR=/data`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN` and `BASE_URL`. Railway sets `PORT` itself; the app reads it.
3. Open **Settings > Volumes**, add a volume and mount it at `/data`.
4. Under **Settings > Networking**, generate a public domain, and put it in `BASE_URL`.
5. Do the Stripe webhook steps in section 3.

### Docker (any VPS)

```bash
docker build -t tailorcv .
docker run -d --name tailorcv --restart unless-stopped \
  -p 3000:3000 \
  -v tailorcv-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e STRIPE_SECRET_KEY=sk_test_... \
  -e STRIPE_WEBHOOK_SECRET=whsec_... \
  -e ADMIN_TOKEN=... \
  -e BASE_URL=https://tailorcv.example.com \
  tailorcv
```

The image sets `NODE_ENV=production` and `DATA_DIR=/data` for you. Put a reverse proxy with TLS (Caddy, nginx, Traefik) in front of port 3000; Stripe only calls `https` webhook URLs.

## First-hour checklist

Do these in order, right after the first deploy.

1. **Place a test order.** With the `sk_test_` key set, open the site, paste any resume and job posting and pay with card `4242 4242 4242 4242`, any future expiry, any CVC, any postal code. The result page should fill in within a minute or two. If it stays on "waiting for payment", the webhook secret is wrong or missing.
2. **Check the webhook delivered.** In Stripe, **Developers > Webhooks > your endpoint**, the latest `checkout.session.completed` event should show `200`.
3. **Go live.** Swap `STRIPE_SECRET_KEY` to `sk_live_...`, create the live-mode webhook (section 3, step 6) and set its `whsec_` secret. Redeploy or restart.
4. **Buy and refund one real order.** Use your own card at full price. Confirm the documents arrive, then refund it in Stripe (**Payments > the payment > Refund**). That proves the live keys, the webhook and the refund path all work before a customer hits them.
5. **Check the admin stats.**
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://YOUR-DOMAIN/api/admin/stats
   ```
   You should see your two orders counted. A `401` means the token does not match.
6. **Submit the sitemap.** In https://search.google.com/search-console add the domain, verify it (DNS record is simplest) and submit `https://YOUR-DOMAIN/sitemap.xml` under **Sitemaps**. The 30 resume guides at `/resume/` are what bring free traffic; they are not indexed until you do this.
7. **Set a billing alert** at console.anthropic.com (**Billing > Spend limits**) so a traffic spike cannot surprise you.

## Troubleshooting

- **Service exits at start with "STRIPE_SECRET_KEY is required in production"**: `NODE_ENV=production` is set but the Stripe key is missing.
- **Orders disappear after a deploy**: `DATA_DIR` is not on the persistent disk. It must be `/data` on Render, Fly and Docker setups above.
- **Webhook shows 400 in Stripe**: the signing secret does not match the mode (test vs live) or the endpoint. Reveal it again and reset the env var.
- **Buyer lands on the wrong site after paying**: `BASE_URL` still points at the old `.onrender.com` or `.fly.dev` URL.
