// File features: resume upload extraction (PDF/DOCX) and .docx download of the result.
// Run with: node --test --test-concurrency=1 test/files.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";

const RESUME = "Jane Doe — Product Designer. ".repeat(12);
const JOB = "Senior Product Designer at Acme. Figma, research, design systems. ".repeat(3);
const servers = [];

async function startServer(env) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tcv-"));
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
  return { base, call, dataDir };
}

async function waitFor(call, id, want, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const { data } = await call("GET", `/api/jobs/${id}`);
    if (want.includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} never reached ${want}`);
}

// A minimal single-page PDF with one line of Helvetica text, with a correct xref table.
function makePdf(text) {
  const stream = `BT /F1 18 Tf 50 740 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function makeDocx(lines) {
  const doc = new Document({ sections: [{ children: lines.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] });
  return Packer.toBuffer(doc);
}

async function upload(srv, buffer, filename, type) {
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type }), filename);
  const r = await fetch(srv.base + "/api/extract", { method: "POST", body: fd });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

let ok;
before(async () => { ok = await startServer({ TAILOR_MOCK: "ok" }); });
after(() => servers.forEach((p) => p.kill()));

test("extracts text from an uploaded PDF", async () => {
  const r = await upload(ok, makePdf("Jane Doe Product Designer with Figma experience"), "resume.pdf", "application/pdf");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.text, /Jane Doe Product Designer/);
});

test("extracts text from an uploaded DOCX", async () => {
  const buf = await makeDocx(["Jane Doe", "Product Designer at Acme", "Led a design system migration."]);
  const r = await upload(ok, buf, "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.text, /Jane Doe/);
  assert.match(r.data.text, /design system migration/);
});

test("rejects other file types, empty text and non-multipart bodies", async () => {
  const txt = await upload(ok, Buffer.from("just some text"), "resume.txt", "text/plain");
  assert.equal(txt.status, 400);
  assert.match(txt.data.error, /PDF or Word/);

  const empty = await upload(ok, makePdf(""), "blank.pdf", "application/pdf");
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /paste the text/);

  const garbage = await upload(ok, Buffer.from("%PDF-1.4 not really a pdf"), "bad.pdf", "application/pdf");
  assert.equal(garbage.status, 400);

  const json = await ok.call("POST", "/api/extract", { hello: "world" });
  assert.equal(json.status, 400);
});

test("rejects uploads over 5 MB", async () => {
  const big = Buffer.concat([makePdf("big"), Buffer.alloc(5 * 1024 * 1024 + 10, 0x20)]);
  const r = await upload(ok, big, "big.pdf", "application/pdf");
  assert.equal(r.status, 400);
  assert.match(r.data.error, /too big/);
});

test("finished order downloads as a Word document", async () => {
  const r = await ok.call("POST", "/api/checkout", { resume: RESUME, job: JOB });
  assert.equal(r.status, 200);
  const id = new URL(r.data.url, ok.base).searchParams.get("id");
  await waitFor(ok.call, id, ["done"]);

  const res = await fetch(`${ok.base}/api/jobs/${id}/docx`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="tailored-resume\.docx"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), "PK");

  const file = path.join(ok.dataDir, "out.docx");
  await fs.writeFile(file, buf);
  const xml = execFileSync("unzip", ["-p", file, "word/document.xml"], { encoding: "utf8" });
  assert.match(xml, /Cover Letter/);
  assert.match(xml, /Tailored Resume/);
  assert.match(xml, /<w:b\/>/); // **Jane Doe** became bold
  assert.match(xml, /<w:numPr>/); // bullets became a list

  assert.equal((await ok.call("GET", "/api/jobs/" + "a".repeat(32) + "/docx")).status, 404);
});

test("unfinished order refuses the docx download", async () => {
  const failing = await startServer({ TAILOR_MOCK: "fail" });
  const r = await failing.call("POST", "/api/checkout", { resume: RESUME, job: JOB });
  const id = new URL(r.data.url, failing.base).searchParams.get("id");
  await waitFor(failing.call, id, ["failed"]);
  assert.equal((await failing.call("GET", `/api/jobs/${id}/docx`)).status, 409);
});
