// Admin read-only endpoints. Enabled only when ADMIN_TOKEN is set; callers send `Authorization: Bearer <token>`.
import crypto from "node:crypto";
import { Router } from "express";
import { db } from "./db.js";

const PRICE_CENTS = Number(process.env.PRICE_CENTS || 900);
const PACK_PRICE_CENTS = Number(process.env.PACK_PRICE_CENTS || 2900);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const STATUSES = new Set(["awaiting_payment", "paid", "generating", "done", "failed"]);

const stmts = {
  byStatus: db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"),
  stripeOrders: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status <> 'awaiting_payment' AND json_extract(data, '$.paidWith') = 'stripe'"),
  packsSold: db.prepare("SELECT COUNT(*) AS n FROM codes WHERE status <> 'awaiting_payment'"),
  perDay: db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM jobs WHERE created_at >= ? AND status <> 'awaiting_payment' GROUP BY day"),
  list: db.prepare("SELECT data FROM jobs ORDER BY created_at DESC LIMIT ?"),
  listByStatus: db.prepare("SELECT data FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?"),
};

const sameToken = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: "Not found." });
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  if (!m || !sameToken(m[1].trim(), ADMIN_TOKEN)) return res.status(401).json({ error: "Unauthorized." });
  res.set("Cache-Control", "no-store");
  next();
});

adminRouter.get("/stats", (_req, res) => {
  const orders = { total: 0, done: 0, failed: 0, awaiting_payment: 0 };
  for (const { status, n } of stmts.byStatus.all()) {
    orders.total += Number(n);
    if (status in orders) orders[status] += Number(n);
  }
  const paidSingles = Number(stmts.stripeOrders.get().n);
  const packsSold = Number(stmts.packsSold.get().n);

  const days = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 6);
  const counts = new Map(stmts.perDay.all(start.toISOString()).map((r) => [r.day, Number(r.n)]));
  for (let i = 0; i < 7; i++) {
    const day = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    days.push({ day, orders: counts.get(day) || 0 });
  }

  res.json({
    orders,
    packsSold,
    revenueCents: paidSingles * PRICE_CENTS + packsSold * PACK_PRICE_CENTS,
    last7days: days,
  });
});

adminRouter.get("/jobs", (req, res) => {
  const status = String(req.query.status || "");
  if (status && !STATUSES.has(status)) return res.status(400).json({ error: "Unknown status." });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const rows = status ? stmts.listByStatus.all(status, limit) : stmts.list.all(limit);
  const jobs = [];
  for (const { data } of rows) {
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    // Never expose resume/job text or generated documents here.
    jobs.push({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt || null,
      attempts: j.attempts || 0,
      lastError: j.lastError || null,
      paidWith: j.paidWith || null,
    });
  }
  res.json({ jobs });
});
