// Minimal JSON-file job store. Fine for a launch; swap for a database once volume grows.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DIR = process.env.DATA_DIR || "./data";
await fs.mkdir(DIR, { recursive: true });

const file = (id) => path.join(DIR, `${id}.json`);
const validId = (id) => /^[a-f0-9]{32}$/.test(id);

export async function createJob(data) {
  const id = crypto.randomBytes(16).toString("hex");
  await saveJob({ id, status: "awaiting_payment", createdAt: new Date().toISOString(), ...data });
  return id;
}

export async function getJob(id) {
  if (!validId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(file(id), "utf8"));
  } catch {
    return null;
  }
}

export async function saveJob(job) {
  await fs.writeFile(file(job.id), JSON.stringify(job));
}
