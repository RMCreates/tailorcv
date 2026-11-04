# TailorCV launch and promotion plan

Do these in order. The early steps unlock the later ones.

## Phase 0: get live (day 1, about 2 hours)
1. **Buy a domain** (about $10/year, from Namecheap, Porkbun or Cloudflare). Choose something short, like `tailorcv.app` or `tailormyresume.com`.
2. **Replace placeholders.** Change `YOURDOMAIN.com` to your domain in `public/sitemap.xml`, `public/robots.txt`, `public/privacy.html` and `public/terms.html`, and add your support email.
3. **Deploy on Render** (or Railway) from the GitHub repo. Set `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_URL`, `NODE_ENV=production` and `DATA_DIR` (pointing at a persistent disk).
4. **Stripe:** activate your account, add a webhook at `https://yourdomain/api/stripe/webhook` for `checkout.session.completed`, and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. **Test** one $9 order and one 5-pack with test card `4242 4242 4242 4242`, then switch to live keys. Buy one real order yourself and refund it.
6. **Have the legal templates reviewed** (privacy and terms), even with a quick paid review service.

## Phase 1: free foundations (days 1–3)
7. **Google Search Console:** verify the domain and submit `/sitemap.xml`. The 30 `/resume/<role>` guides are your long-term free traffic.
8. **Bing Webmaster Tools:** import from Search Console (one click).
9. **Analytics:** add Plausible or Umami (privacy-friendly, one script tag) so you can see which channels bring buyers.
10. **Social profiles** (same handle everywhere): LinkedIn page, X, TikTok, Instagram, Pinterest and YouTube (for Shorts). Link to the site in each bio.

## Phase 2: launch week (days 3–10)
11. **Run the drafting bot every week:** `npm run promo` writes a week of posts to `promo/`. Week 1 is already written in `promo/week-1.md`.
12. **LinkedIn:** post once a day from your *personal* profile. It reaches more people than a company page. Job seekers and recruiters are there, so this is your best channel.
13. **TikTok, Reels and Shorts:** post the same 30–45s video to all three. "Before and after" resume rewrites (with a made-up sample resume, never a real person's) do well.
14. **Reddit (r/resumes, r/jobs, r/careerguidance, r/cscareerquestions and others):** answer questions *helpfully* and don't link the product. Read each subreddit's self-promotion rules. Put the link in your profile. Some subreddits allow a weekly self-promotion thread, so use those.
15. **Launch posts:** Product Hunt (on a Tuesday–Thursday), Hacker News "Show HN" (be candid: "I built a $9 resume tailor"), Indie Hackers and BetaList.
16. **Directories:** list it on AI-tool directories such as There's An AI For That and Futurepedia, and on job-seeker resource lists. Several are free.

## Phase 3: compounding (weeks 2–8)
17. **Pinterest:** one pin per `/resume/` guide (30 pins). Pinterest traffic lasts for months.
18. **More SEO pages:** add 10 role guides a week and "cover letter for X" pages. Watch Search Console for queries you almost rank for.
19. **Partnerships:** offer career coaches, bootcamps and university career centers a discount code. Create codes in Stripe under Coupons; promotion codes already work at checkout.
20. **Affiliates:** give creators who post job-search content 30% per sale (Stripe promotion codes per creator, tracked by code).
21. **Email:** add an optional "send me job-search tips" checkbox and a weekly tips email (Buttondown or ConvertKit free tier). Repeat buyers come from email.
22. **Paid tests (only once organic converts):** $5–10/day on Reddit or Google ads for searches like "tailor resume to job description". Stop any ad that doesn't break even within $50.

## Numbers to watch
- **Visitor → order conversion:** aim for 2–4%. Below 1% means the landing page needs work.
- **Cost per order** from ads must stay under about $8 (your margin).
- **Share of buyers who choose the 5-pack:** higher is better. Test $25 vs $29.

## Rules that keep your accounts safe
- One real account per platform. No sockpuppets, fake reviews or bought upvotes.
- Disclose that it's your product when you mention it.
- Don't run bots that post or DM on your behalf in communities. They get accounts and domains banned. The drafting bot writes; you publish.
