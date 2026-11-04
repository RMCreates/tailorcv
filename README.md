# TailorCV

A pay-per-use web app. A job seeker pastes a resume and a job posting, pays once through Stripe Checkout (default $9), and gets back:

- a short **match summary**: fit, strengths and gaps,
- the resume **rewritten for that posting** (ATS keywords, stronger bullet points, nothing invented),
- a **cover letter** for that company and role.

Claude (`claude-opus-5-5`) writes the documents.

## How it makes money

| Per order | Amount |
|---|---|
| Price | $9.00 |
| Stripe fee (2.9% + 30¢) | −$0.56 |
| Claude API (about 8k input and 6k output tokens) | about −$0.15 to −$0.30 |
| **Margin** | **about $8.10** |

People applying to many jobs come back for each posting, which is the case for tailoring per job. Ways to grow: credit packs (5 for $29), a monthly plan, and SEO pages such as "resume for [job title]".

## Run locally

```bash
npm install
cp .env.example .env    # add ANTHROPIC_API_KEY
npm run dev             # http://localhost:3000
```

Without `STRIPE_SECRET_KEY`, and outside production, the app skips payment so you can test the full flow for free.

## Deploy (Render, Railway, Fly.io or any Node host)

1. Set the environment variables from `.env.example`: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY` (start with a `sk_test_` key), `STRIPE_WEBHOOK_SECRET`, `BASE_URL` (your public URL) and `NODE_ENV=production`.
   In Stripe, add a webhook endpoint `https://yourdomain/api/stripe/webhook` for `checkout.session.completed`.
2. Start command: `npm start`.
3. Mount a persistent disk and point `DATA_DIR` at it. Otherwise orders are lost when the server redeploys.
4. Place a test order with Stripe test card `4242 4242 4242 4242`, then switch to your live key.

## How it works

- `POST /api/checkout` validates the input, saves the order and creates a Stripe Checkout session.
- Stripe sends the buyer to `/result.html?id=…&session_id=…`. The page polls `GET /api/jobs/:id`, which confirms with Stripe that the order is paid and then starts generation (once per order).
- If generation fails, the buyer gets up to 3 free retries. After that the page asks them to contact support for a refund.
- Orders and credit codes are stored in a SQLite database at `DATA_DIR/tailorcv.sqlite` (Node's built-in `node:sqlite`, no native dependency). Move to Postgres once you run more than one instance.

## Included

- Single orders ($9) and **5-pack credit codes** ($29). Buyers get a `TCV-XXXX-XXXX-XXXX` code to spend later. A credit is returned automatically if an order fails 3 times.
- A Stripe webhook plus a check on the redirect page, so paid orders run even if the buyer closes the tab.
- A per-IP rate limit on checkout and automatic deletion of orders after 30 days (`RETENTION_DAYS`).
- Resume upload: buyers can upload a PDF or DOCX instead of pasting (`POST /api/extract`, 5 MB max, rate-limited).
- Download the result as a Word file (`GET /api/jobs/:id/docx`) as well as Markdown or print-to-PDF.
- 30 SEO resume guides at `/resume/`, plus `sitemap.xml`, `robots.txt`, and privacy and terms templates.
- A read-only admin API when `ADMIN_TOKEN` is set: `GET /api/admin/stats` (order counts, packs sold, revenue, orders per day for the last 7 days) and `GET /api/admin/jobs?status=failed&limit=50` (order metadata only, never resume text). Send `Authorization: Bearer <ADMIN_TOKEN>`.
- Tests: `npm test` covers 11 end-to-end tests with a mocked AI call, including persistence across a restart.
- A promo drafting bot: `npm run promo` writes a week of posts to `promo/` for you to review. See `PROMOTION.md`.

## Before you launch

- Replace `YOURDOMAIN.com` and `support@YOURDOMAIN.com` in `public/`, and have the privacy and terms templates reviewed.
