// End-to-end API tests. Run with: npm test
// Spins up real server processes with a temp DATA_DIR and a mocked Claude call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { DatabaseSync } from "node:sqlite";

const RESUME = "Jane Doe — Product Designer. ".repeat(12);
const JOB = "Senior Product Designer at Acme. Figma, research, design systems. ".repeat(3);
const servers = [];

// Seed an order straight into the SQLite store (same schema as lib/db.js).
function seedJob(dataDir, job) {
  const db = new DatabaseSync(path.join(dataDir, "tailorcv.sqlite"));
  const ts = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO jobs (id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)")
    .run(job.id, job.status, job.createdAt || ts, ts, JSON.stringify(job));
  db.close();
}

async function startServer(env, dataDir) {
  dataDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "tcv-"));
  const port = 4000 + Math.floor(Math.random() * 2000);
  const proc = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, STRIPE_SECRET_KEY: "", NODE_ENV: "test", RATE_LIMIT_MAX: "1000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(proc);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 8000);
    proc.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  const stop = () => new Promise((r) => { proc.once("exit", r); proc.kill(); });
  return { base, call, dataDir, stop };
}

async function waitFor(call, id, want, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const { data } = await call("GET", `/api/jobs/${id}`);
    if (want.includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} never reached ${want}`);
}

let ok, failing;
before(async () => {
  ok = await startServer({ TAILOR_MOCK: "ok" });
  failing = await startServer({ TAILOR_MOCK: "fail" });
});
after(() => servers.forEach((p) => p.kill()));

test("config exposes prices", async () => {
  const { data } = await ok.call("GET", "/api/config");
  assert.equal(data.priceCents, 900);
  assert.equal(data.packCredits, 5);
  assert.equal(data.devFree, true);
});

test("rejects short input", async () => {
  const r = await ok.call("POST", "/api/checkout", { resume: "short", job: JOB });
  assert.equal(r.status, 400);
});

test("dev order generates a result", async () => {
  const r = await ok.call("POST", "/api/checkout", { resume: RESUME, job: JOB });
  assert.equal(r.status, 200);
  const id = new URL(r.data.url, ok.base).searchParams.get("id");
  const done = await waitFor(ok.call, id, ["done"]);
  assert.match(done.result, /## Cover Letter/);
});

test("unknown and malformed job ids 404", async () => {
  assert.equal((await ok.call("GET", "/api/jobs/" + "a".repeat(32))).status, 404);
  assert.equal((await ok.call("GET", "/api/jobs/../../etc/passwd")).status, 404);
});

test("credit pack: buy, spend all credits, then refuse", async () => {
  const p = await ok.call("POST", "/api/pack", { email: "a@b.co" });
  const code = new URL(p.data.url, ok.base).searchParams.get("code");
  const info = await ok.call("GET", `/api/pack/${code}`);
  assert.equal(info.data.credits, 5);

  // Spend 5 credits concurrently: all must succeed, none double-spent.
  const spends = await Promise.all(
    Array.from({ length: 6 }, () => ok.call("POST", "/api/checkout", { resume: RESUME, job: JOB, code: code.toLowerCase() })),
  );
  assert.equal(spends.filter((s) => s.status === 200).length, 5);
  assert.equal(spends.filter((s) => s.status === 400).length, 1);
  assert.equal((await ok.call("GET", `/api/pack/${code}`)).data.credits, 0);
});

test("bad credit code is rejected", async () => {
  const r = await ok.call("POST", "/api/checkout", { resume: RESUME, job: JOB, code: "TCV-AAAA-BBBB-CCCC" });
  assert.equal(r.status, 400);
  const r2 = await ok.call("POST", "/api/checkout", { resume: RESUME, job: JOB, code: "nope" });
  assert.equal(r2.status, 400);
});

test("failures allow 3 attempts, then refund the credit", async () => {
  const p = await failing.call("POST", "/api/pack", {});
  const code = new URL(p.data.url, failing.base).searchParams.get("code");
  const r = await failing.call("POST", "/api/checkout", { resume: RESUME, job: JOB, code });
  const id = new URL(r.data.url, failing.base).searchParams.get("id");
  assert.equal((await failing.call("GET", `/api/pack/${code}`)).data.credits, 4);

  let s = await waitFor(failing.call, id, ["failed"]);
  assert.equal(s.canRetry, true);
  for (let i = 0; i < 2; i++) {
    assert.equal((await failing.call("POST", `/api/jobs/${id}/retry`)).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    s = await waitFor(failing.call, id, ["failed"]);
  }
  assert.equal(s.canRetry, false);
  assert.equal(s.creditRefunded, true);
  assert.equal((await failing.call("POST", `/api/jobs/${id}/retry`)).status, 409);
  assert.equal((await failing.call("GET", `/api/pack/${code}`)).data.credits, 5);
});

test("rate limit kicks in after 10 orders per window", async () => {
  const srv = await startServer({ TAILOR_MOCK: "ok", RATE_LIMIT_MAX: "10" });
  const results = [];
  for (let i = 0; i < 12; i++) results.push((await srv.call("POST", "/api/checkout", { resume: "x", job: "y" })).status);
  assert.deepEqual(results.slice(0, 10), Array(10).fill(400));
  assert.deepEqual(results.slice(10), [429, 429]);
});

test("stripe webhook: rejects bad signature, accepts signed event and pays the order", async () => {
  const secret = "whsec_test_secret";
  const srv = await startServer({ STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_WEBHOOK_SECRET: secret, TAILOR_MOCK: "ok" });
  // Seed an awaiting-payment order directly (creating a real Checkout session needs network).
  const id = "b".repeat(32);
  seedJob(srv.dataDir, { id, status: "awaiting_payment", resume: RESUME, job: JOB, stripeSessionId: "cs_test_123" });
  const event = JSON.stringify({
    id: "evt_1", object: "event", type: "checkout.session.completed",
    data: { object: { id: "cs_test_123", object: "checkout.session", payment_status: "paid", metadata: { jobId: id } } },
  });
  const bad = await srv.call("POST", "/api/stripe/webhook", event, { "stripe-signature": "t=1,v1=bad" });
  assert.equal(bad.status, 400);

  const sig = Stripe.webhooks.generateTestHeaderString({ payload: event, secret });
  const good = await srv.call("POST", "/api/stripe/webhook", event, { "stripe-signature": sig });
  assert.equal(good.status, 200);
  const done = await waitFor(srv.call, id, ["done"]);
  assert.match(done.result, /Tailored Resume/);

  // A forged event for a different session must not mark the order paid.
  const id2 = "c".repeat(32);
  seedJob(srv.dataDir, { id: id2, status: "awaiting_payment", resume: RESUME, job: JOB, stripeSessionId: "cs_test_real" });
  const ev2 = JSON.stringify({
    id: "evt_2", object: "event", type: "checkout.session.completed",
    data: { object: { id: "cs_test_other", payment_status: "paid", metadata: { jobId: id2 } } },
  });
  await srv.call("POST", "/api/stripe/webhook", ev2, { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: ev2, secret }) });
  assert.equal((await srv.call("GET", `/api/jobs/${id2}`)).data.status, "awaiting_payment");
});

test("data persists across a server restart", async () => {
  const first = await startServer({ TAILOR_MOCK: "ok" });
  const p = await first.call("POST", "/api/pack", { email: "keep@me.co" });
  const code = new URL(p.data.url, first.base).searchParams.get("code");
  const r = await first.call("POST", "/api/checkout", { resume: RESUME, job: JOB });
  const id = new URL(r.data.url, first.base).searchParams.get("id");
  await waitFor(first.call, id, ["done"]);
  await first.stop();

  const second = await startServer({ TAILOR_MOCK: "ok" }, first.dataDir);
  const info = await second.call("GET", `/api/pack/${code}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.credits, 5);
  assert.equal(info.data.status, "active");
  const job = await second.call("GET", `/api/jobs/${id}`);
  assert.equal(job.data.status, "done");
  assert.match(job.data.result, /## Cover Letter/);
});

test("admin endpoints: 404 without ADMIN_TOKEN, 401 on a bad token, stats shape", async () => {
  assert.equal((await ok.call("GET", "/api/admin/stats")).status, 404);
  assert.equal((await ok.call("GET", "/api/admin/stats", undefined, { Authorization: "Bearer anything" })).status, 404);

  const srv = await startServer({ TAILOR_MOCK: "ok", ADMIN_TOKEN: "s3cret" });
  assert.equal((await srv.call("GET", "/api/admin/stats")).status, 401);
  assert.equal((await srv.call("GET", "/api/admin/stats", undefined, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await srv.call("GET", "/api/admin/jobs", undefined, { Authorization: "Bearer wrong" })).status, 401);

  const auth = { Authorization: "Bearer s3cret" };
  // One dev order, one pack, and a paid Stripe order + a failed order seeded directly.
  const r = await srv.call("POST", "/api/checkout", { resume: RESUME, job: JOB });
  const id = new URL(r.data.url, srv.base).searchParams.get("id");
  await waitFor(srv.call, id, ["done"]);
  await srv.call("POST", "/api/pack", {});
  seedJob(srv.dataDir, { id: "d".repeat(32), status: "done", paidWith: "stripe", resume: RESUME, job: JOB, result: "x" });
  seedJob(srv.dataDir, { id: "e".repeat(32), status: "failed", paidWith: "code", attempts: 3, lastError: "boom", resume: RESUME, job: JOB });
  seedJob(srv.dataDir, { id: "f".repeat(32), status: "awaiting_payment", resume: RESUME, job: JOB });

  const stats = await srv.call("GET", "/api/admin/stats", undefined, auth);
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.data.orders, { total: 4, done: 2, failed: 1, awaiting_payment: 1 });
  assert.equal(stats.data.packsSold, 1);
  assert.equal(stats.data.revenueCents, 900 + 2900);
  assert.equal(stats.data.last7days.length, 7);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(stats.data.last7days.at(-1).day, today);
  assert.equal(stats.data.last7days.at(-1).orders, 3);
  for (const d of stats.data.last7days) assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);

  const failed = await srv.call("GET", "/api/admin/jobs?status=failed&limit=50", undefined, auth);
  assert.equal(failed.status, 200);
  assert.equal(failed.data.jobs.length, 1);
  assert.deepEqual(Object.keys(failed.data.jobs[0]).sort(), ["attempts", "createdAt", "id", "lastError", "paidWith", "status"]);
  assert.equal(failed.data.jobs[0].lastError, "boom");
  assert.ok(!JSON.stringify(failed.data).includes("Jane Doe"), "resume text must not leak");
  assert.equal((await srv.call("GET", "/api/admin/jobs?status=bogus", undefined, auth)).status, 400);
  assert.equal((await srv.call("GET", "/api/admin/jobs", undefined, auth)).data.jobs.length, 4);
});
