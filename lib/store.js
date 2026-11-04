// Minimal JSON-file store. Fine for a launch; swap for a database once volume grows.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DIR = process.env.DATA_DIR || "./data";
const JOBS = path.join(DIR, "jobs");
const CODES = path.join(DIR, "codes");
await fs.mkdir(JOBS, { recursive: true });
await fs.mkdir(CODES, { recursive: true });

const jobFile = (id) => path.join(JOBS, `${id}.json`);
const codeFile = (code) => path.join(CODES, `${code}.json`);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

// ---- Orders ----
export async function createJob(data) {
  const id = crypto.randomBytes(16).toString("hex");
  await saveJob({ id, status: "awaiting_payment", createdAt: new Date().toISOString(), ...data });
  return id;
}
export const getJob = (id) => (validId(id) ? readJson(jobFile(id)) : Promise.resolve(null));
export const saveJob = (job) => writeJson(jobFile(job.id), job);

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
  await writeJson(codeFile(code), { code, credits: 0, status: "awaiting_payment", createdAt: new Date().toISOString(), ...data });
  return code;
}
export async function getCode(code) {
  const c = normalizeCode(code);
  return c ? readJson(codeFile(c)) : null;
}
export const saveCode = (rec) => writeJson(codeFile(rec.code), rec);

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
export async function purgeOldJobs(days) {
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const name of await fs.readdir(JOBS)) {
    if (!name.endsWith(".json")) continue;
    const f = path.join(JOBS, name);
    try {
      const { mtimeMs } = await fs.stat(f);
      if (mtimeMs < cutoff) {
        await fs.unlink(f);
        removed++;
      }
    } catch {}
  }
  return removed;
}
