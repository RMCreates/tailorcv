import express from "express";
import Stripe from "stripe";
import { tailor } from "./lib/claude.js";
import {
  createJob, getJob, saveJob,
  createCode, getCode, saveCode, normalizeCode, withCodeLock,
  purgeOldJobs,
} from "./lib/store.js";
import { rateLimit } from "./lib/rate-limit.js";

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PRICE_CENTS = Number(process.env.PRICE_CENTS || 900);
const PACK_PRICE_CENTS = Number(process.env.PACK_PRICE_CENTS || 2900);
const PACK_CREDITS = Number(process.env.PACK_CREDITS || 5);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const MAX_ATTEMPTS = 3;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const DEV_FREE = !stripe && process.env.NODE_ENV !== "production";

if (!stripe && !DEV_FREE) {
  console.error("STRIPE_SECRET_KEY is required in production.");
  process.exit(1);
}

const MAX_RESUME = 20000;
const MAX_JOB = 15000;
const running = new Set();
const money = (c) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);

const app = express();
app.set("trust proxy", 1); // behind Render/Railway/Fly proxies, so req.ip is the client

// ---- Stripe webhook (needs the raw body, so it is registered before express.json) ----
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !WEBHOOK_SECRET) return res.status(404).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await handlePaidSession(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("webhook handler error", err);
    res.status(500).end(); // Stripe retries
  }
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static("public", { extensions: ["html"] }));

const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: Number(process.env.RATE_LIMIT_MAX || 10) });

app.get("/api/config", (_req, res) => {
  res.json({ priceCents: PRICE_CENTS, packPriceCents: PACK_PRICE_CENTS, packCredits: PACK_CREDITS, devFree: DEV_FREE });
});

// ---- Payment confirmation shared by the redirect and the webhook ----
async function handlePaidSession(session) {
  if (session.payment_status !== "paid") return;
  const { jobId, packCode } = session.metadata || {};
  if (jobId) {
    const job = await getJob(jobId);
    if (job && job.status === "awaiting_payment" && job.stripeSessionId === session.id) {
      await saveJob({ ...job, status: "paid", paidWith: "stripe" });
      runJob(jobId);
    }
  }
  if (packCode) {
    await withCodeLock(packCode, async () => {
      const rec = await getCode(packCode);
      if (rec && rec.status === "awaiting_payment" && rec.stripeSessionId === session.id) {
        await saveCode({ ...rec, status: "active", credits: rec.credits + PACK_CREDITS, paidAt: new Date().toISOString() });
      }
    });
  }
}

async function confirmSession(sessionId) {
  if (!stripe || !sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  await handlePaidSession(session);
}

// ---- Single order ----
app.post("/api/checkout", orderLimiter, async (req, res) => {
  const resume = String(req.body?.resume || "").trim();
  const job = String(req.body?.job || "").trim();
  const email = String(req.body?.email || "").trim().slice(0, 200);
  const rawCode = String(req.body?.code || "").trim();
  if (resume.length < 200) return res.status(400).json({ error: "Please paste your full resume (at least 200 characters)." });
  if (job.length < 100) return res.status(400).json({ error: "Please paste the full job posting (at least 100 characters)." });
  if (resume.length > MAX_RESUME || job.length > MAX_JOB) {
    return res.status(400).json({ error: "That's too long. Trim the resume to 20,000 and the posting to 15,000 characters." });
  }

  // Pay with a prepaid credit code
  if (rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) return res.status(400).json({ error: "That credit code doesn't look right. It should look like TCV-XXXX-XXXX-XXXX." });
    const result = await withCodeLock(code, async () => {
      const rec = await getCode(code);
      if (!rec || rec.status !== "active") return { error: "That credit code isn't valid." };
      if (rec.credits < 1) return { error: "That credit code has no credits left." };
      const id = await createJob({ resume, job, email, status: "paid", paidWith: "code", code });
      await saveCode({ ...rec, credits: rec.credits - 1, used: [...(rec.used || []), id] });
      return { id, remaining: rec.credits - 1 };
    });
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json({ url: `/result.html?id=${result.id}`, remaining: result.remaining });
  }

  if (DEV_FREE) {
    const id = await createJob({ resume, job, email, status: "paid", paidWith: "dev" });
    return res.json({ url: `/result.html?id=${id}` });
  }

  const id = await createJob({ resume, job, email });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: {
            name: "Tailored resume + cover letter",
            description: "Your resume rewritten for one job posting, plus a matching cover letter.",
          },
        },
      }],
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: { jobId: id },
      success_url: `${BASE_URL}/result.html?id=${id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?canceled=1`,
    });
    const j = await getJob(id);
    await saveJob({ ...j, stripeSessionId: session.id });
    res.json({ url: session.url });
  } catch (err) {
    console.error("checkout error", err);
    res.status(502).json({ error: "Couldn't start checkout. Please try again." });
  }
});

async function runJob(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    let job = await getJob(id);
    if (!job || !["paid", "generating"].includes(job.status)) return;
    await saveJob({ ...job, status: "generating" });
    try {
      const { markdown, usage } = await tailor({ resume: job.resume, job: job.job });
      job = await getJob(id);
      await saveJob({ ...job, status: "done", result: markdown, usage, finishedAt: new Date().toISOString() });
    } catch (err) {
      console.error("generation error", id, err);
      job = await getJob(id);
      const attempts = (job.attempts || 0) + 1;
      let refunded = job.creditRefunded || false;
      // Out of retries on a credit-code order: give the credit back automatically.
      if (attempts >= MAX_ATTEMPTS && job.paidWith === "code" && !refunded) {
        await withCodeLock(job.code, async () => {
          const rec = await getCode(job.code);
          if (rec) await saveCode({ ...rec, credits: rec.credits + 1 });
        });
        refunded = true;
      }
      await saveJob({ ...job, status: "failed", attempts, creditRefunded: refunded, lastError: String(err.message || err) });
    }
  } finally {
    running.delete(id);
  }
}

app.get("/api/jobs/:id", async (req, res) => {
  let job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found." });
  if (job.status === "awaiting_payment" && req.query.session_id === job.stripeSessionId) {
    try {
      await confirmSession(req.query.session_id);
      job = await getJob(job.id);
    } catch (err) {
      console.error("verify error", err);
    }
  }
  if ((job.status === "paid" || job.status === "generating") && !running.has(job.id)) {
    runJob(job.id); // also resumes orders interrupted by a restart
    job = { ...job, status: "generating" };
  }
  res.json({
    status: job.status,
    result: job.status === "done" ? job.result : undefined,
    canRetry: job.status === "failed" && (job.attempts || 0) < MAX_ATTEMPTS,
    creditRefunded: job.creditRefunded || false,
  });
});

app.post("/api/jobs/:id/retry", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found." });
  if (job.status !== "failed" || (job.attempts || 0) >= MAX_ATTEMPTS) {
    return res.status(409).json({ error: "This order can't be retried. Contact support for a refund." });
  }
  await saveJob({ ...job, status: "paid" });
  runJob(job.id);
  res.json({ ok: true });
});

// ---- Credit packs ----
app.post("/api/pack", orderLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().slice(0, 200);
  const code = await createCode({ email });
  if (DEV_FREE) {
    const rec = await getCode(code);
    await saveCode({ ...rec, status: "active", credits: PACK_CREDITS, paidAt: new Date().toISOString() });
    return res.json({ url: `/pack.html?code=${code}` });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PACK_PRICE_CENTS,
          product_data: {
            name: `${PACK_CREDITS}-pack: tailored resumes + cover letters`,
            description: `${PACK_CREDITS} tailored resume + cover letter orders, one per job posting. Credits don't expire.`,
          },
        },
      }],
      customer_email: email || undefined,
      allow_promotion_codes: true,
      metadata: { packCode: code },
      success_url: `${BASE_URL}/pack.html?code=${code}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?canceled=1`,
    });
    const rec = await getCode(code);
    await saveCode({ ...rec, stripeSessionId: session.id });
    res.json({ url: session.url });
  } catch (err) {
    console.error("pack checkout error", err);
    res.status(502).json({ error: "Couldn't start checkout. Please try again." });
  }
});

app.get("/api/pack/:code", async (req, res) => {
  let rec = await getCode(req.params.code);
  if (!rec) return res.status(404).json({ error: "Code not found." });
  if (rec.status === "awaiting_payment" && req.query.session_id === rec.stripeSessionId) {
    try {
      await confirmSession(req.query.session_id);
      rec = await getCode(rec.code);
    } catch (err) {
      console.error("pack verify error", err);
    }
  }
  res.json({ code: rec.code, status: rec.status, credits: rec.credits });
});

// ---- Housekeeping ----
async function purge() {
  try {
    const n = await purgeOldJobs(RETENTION_DAYS);
    if (n) console.log(`purged ${n} orders older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error("purge error", err);
  }
}
purge();
setInterval(purge, 6 * 3600 * 1000).unref();

app.listen(PORT, () => {
  console.log(`TailorCV listening on ${BASE_URL}${DEV_FREE ? " (dev mode: payments skipped)" : ""} — ${money(PRICE_CENTS)} each, ${PACK_CREDITS} for ${money(PACK_PRICE_CENTS)}`);
});
