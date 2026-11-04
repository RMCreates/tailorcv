// SQLite-backed store (node:sqlite). The API is async so callers don't change if the backend does.
import crypto from "node:crypto";
import { db } from "./db.js";

const validId = (id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
const now = () => new Date().toISOString();

const stmts = {
  getJob: db.prepare("SELECT data FROM jobs WHERE id = ?"),
  putJob: db.prepare(`
    INSERT INTO jobs (id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`),
  getCode: db.prepare("SELECT data FROM codes WHERE code = ?"),
  putCode: db.prepare(`
    INSERT INTO codes (code, status, credits, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET status = excluded.status, credits = excluded.credits,
      updated_at = excluded.updated_at, data = excluded.data`),
  purge: db.prepare("DELETE FROM jobs WHERE created_at < ? AND updated_at < ?"),
};

const parse = (row) => {
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
};

// ---- Orders ----
export async function createJob(data) {
  const id = crypto.randomBytes(16).toString("hex");
  await saveJob({ id, status: "awaiting_payment", createdAt: now(), ...data });
  return id;
}
export async function getJob(id) {
  return validId(id) ? parse(stmts.getJob.get(id)) : null;
}
export async function saveJob(job) {
  const createdAt = job.createdAt || now();
  stmts.putJob.run(job.id, String(job.status || "unknown"), createdAt, now(), JSON.stringify(job));
}

// ---- Prepaid credit codes (e.g. "5 for $29") ----
// Codes look like TCV-XXXX-XXXX-XXXX (no ambiguous characters).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeCode(code) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^TCV[A-Z0-9]{12}$/.test(c)) return null;
  return `TCV-${c.slice(3, 7)}-${c.slice(7, 11)}-${c.slice(11, 15)}`;
}
function newCode() {
  const bytes = crypto.randomBytes(12);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `TCV-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
export async function createCode(data) {
  const code = newCode();
  await saveCode({ code, credits: 0, status: "awaiting_payment", createdAt: now(), ...data });
  return code;
}
export async function getCode(code) {
  const c = normalizeCode(code);
  return c ? parse(stmts.getCode.get(c)) : null;
}
export async function saveCode(rec) {
  const createdAt = rec.createdAt || now();
  stmts.putCode.run(rec.code, String(rec.status || "unknown"), Number(rec.credits) || 0, createdAt, now(), JSON.stringify(rec));
}

// Serialize credit spending per code within this process so two orders can't spend the last credit.
const locks = new Map();
export async function withCodeLock(code, fn) {
  const prev = locks.get(code) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(code, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(code) === chained) locks.delete(code);
  }
}

// ---- Retention: delete orders (they contain resumes) after N days ----
// An order is removed once it was both created and last touched before the cutoff.
export async function purgeOldJobs(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return Number(stmts.purge.run(cutoff, cutoff).changes);
}
