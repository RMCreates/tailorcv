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

1. Set the environment variables from `.env.example`: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY` (start with a `sk_test_` key), `BASE_URL` (your public URL) and `NODE_ENV=production`.
2. Start command: `npm start`.
3. Mount a persistent disk and point `DATA_DIR` at it. Otherwise orders are lost when the server redeploys.
4. Place a test order with Stripe test card `4242 4242 4242 4242`, then switch to your live key.

## How it works

- `POST /api/checkout` validates the input, saves the order and creates a Stripe Checkout session.
- Stripe sends the buyer to `/result.html?id=…&session_id=…`. The page polls `GET /api/jobs/:id`, which confirms with Stripe that the order is paid and then starts generation (once per order).
- If generation fails, the buyer gets up to 3 free retries. After that the page asks them to contact support for a refund.
- Orders are saved as JSON files in `DATA_DIR`. Move to Postgres or SQLite once volume grows.

## Before you launch

- Add a support email, terms and privacy policy to the footer. Stripe requires them.
- Delete order files after 30 days. Resumes contain personal data.
- Add rate limiting (for example `express-rate-limit`) on `/api/checkout`.
- Optionally add a Stripe webhook (`checkout.session.completed`) so an order is generated even if the buyer closes the tab before the redirect.
