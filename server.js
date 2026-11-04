import express from "express";
import Stripe from "stripe";
import { tailor } from "./lib/claude.js";
import { createJob, getJob, saveJob } from "./lib/store.js";

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PRICE_CENTS = Number(process.env.PRICE_CENTS || 900);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const DEV_FREE = !stripe && process.env.NODE_ENV !== "production";

if (!stripe && !DEV_FREE) {
  console.error("STRIPE_SECRET_KEY is required in production.");
  process.exit(1);
}

const MAX_RESUME = 20000;
const MAX_JOB = 15000;
const running = new Set();

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

app.get("/api/config", (_req, res) => {
  res.json({ priceCents: PRICE_CENTS, devFree: DEV_FREE });
});

app.post("/api/checkout", async (req, res) => {
  const resume = String(req.body?.resume || "").trim();
  const job = String(req.body?.job || "").trim();
  const email = String(req.body?.email || "").trim().slice(0, 200);
  if (resume.length < 200) return res.status(400).json({ error: "Please paste your full resume (at least 200 characters)." });
  if (job.length < 100) return res.status(400).json({ error: "Please paste the full job posting (at least 100 characters)." });
  if (resume.length > MAX_RESUME || job.length > MAX_JOB) {
    return res.status(400).json({ error: "That's too long. Trim the resume to 20,000 and the posting to 15,000 characters." });
  }

  const id = await createJob({ resume, job, email });

  if (DEV_FREE) {
    const j = await getJob(id);
    await saveJob({ ...j, status: "paid" });
    return res.json({ url: `/result.html?id=${id}` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: PRICE_CENTS,
            product_data: {
              name: "Tailored resume + cover letter",
              description: "Your resume rewritten for one job posting, plus a matching cover letter.",
            },
          },
        },
      ],
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

async function verifyPaid(job, sessionId) {
  if (job.status !== "awaiting_payment") return job;
  if (!stripe || !sessionId || sessionId !== job.stripeSessionId) return job;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status === "paid" && session.metadata?.jobId === job.id) {
    job = { ...job, status: "paid" };
    await saveJob(job);
  }
  return job;
}

async function runJob(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    let job = await getJob(id);
    await saveJob({ ...job, status: "generating" });
    try {
      const { markdown, usage } = await tailor({ resume: job.resume, job: job.job });
      job = await getJob(id);
      await saveJob({ ...job, status: "done", result: markdown, usage, finishedAt: new Date().toISOString() });
    } catch (err) {
      console.error("generation error", id, err);
      job = await getJob(id);
      // "failed" lets the customer retry (a few times) without paying again.
      await saveJob({ ...job, status: "failed", attempts: (job.attempts || 0) + 1, lastError: String(err.message || err) });
    }
  } finally {
    running.delete(id);
  }
}

app.get("/api/jobs/:id", async (req, res) => {
  let job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found." });
  try {
    job = await verifyPaid(job, req.query.session_id);
  } catch (err) {
    console.error("verify error", err);
  }
  if (job.status === "paid" && !running.has(job.id)) {
    runJob(job.id);
    job = { ...job, status: "generating" };
  }
  if (job.status === "generating" && !running.has(job.id)) {
    // Server restarted mid-generation: start again.
    runJob(job.id);
  }
  res.json({
    status: job.status,
    result: job.status === "done" ? job.result : undefined,
    canRetry: job.status === "failed" && (job.attempts || 0) < 3,
  });
});

app.post("/api/jobs/:id/retry", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found." });
  if (job.status !== "failed" || (job.attempts || 0) >= 3) {
    return res.status(409).json({ error: "This order can't be retried. Contact support for a refund." });
  }
  await saveJob({ ...job, status: "paid" });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`TailorCV listening on ${BASE_URL}${DEV_FREE ? " (dev mode: payments skipped)" : ""}`);
});
