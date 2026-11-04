// Quality eval for the tailoring prompt. Needs ANTHROPIC_API_KEY. Costs a few cents per case.
//   node --env-file-if-exists=.env scripts/eval.js
// Runs each fixture in test/fixtures/eval/*.json through lib/claude.js, then checks:
//   1. structure (three sections in order),
//   2. no hallucinated employers/degrees (every "must_not_appear" string absent),
//   3. keywords from the posting that the resume supports are present,
//   4. cover letter length <= 350 words,
// and asks a second Claude call to grade faithfulness 1-5. Prints a table and exits 1 if any hard check fails.
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { tailor } from "../lib/claude.js";

const dir = "test/fixtures/eval";
const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
const client = new Anthropic();
let failed = 0;

for (const f of files) {
  const c = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
  const t0 = Date.now();
  const { markdown, usage } = await tailor({ resume: c.resume, job: c.job });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const sections = ["## Match Summary", "## Tailored Resume", "## Cover Letter"];
  const idx = sections.map((s) => markdown.indexOf(s));
  const structureOk = idx.every((i) => i >= 0) && idx[0] < idx[1] && idx[1] < idx[2];
  const leaked = (c.must_not_appear || []).filter((s) => markdown.toLowerCase().includes(s.toLowerCase()));
  const missing = (c.should_appear || []).filter((s) => !markdown.toLowerCase().includes(s.toLowerCase()));
  const letter = markdown.slice(idx[2] + sections[2].length);
  const letterWords = letter.trim().split(/\s+/).length;

  const grade = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [{
      role: "user",
      content: `You are auditing an AI-written resume for fabrication.\n\nORIGINAL RESUME:\n${c.resume}\n\nAI OUTPUT:\n${markdown}\n\nList every employer, job title, date, degree, certification, number or skill in the AI output that is NOT supported by the original resume. Then on the last line write "SCORE: n" where n is 5 (nothing invented), 4 (only harmless rewording), 3 (one questionable claim), 2 (clear fabrication), 1 (multiple fabrications).`,
    }],
  });
  const gtext = grade.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const score = Number((gtext.match(/SCORE:\s*(\d)/) || [])[1] || 0);

  const hardFail = !structureOk || leaked.length || letterWords > 350 || score < 4;
  if (hardFail) failed++;
  console.log(`${hardFail ? "FAIL" : "ok  "} ${f.padEnd(28)} ${secs}s  out=${usage.output_tokens}  structure=${structureOk} leaked=${JSON.stringify(leaked)} missingKeywords=${JSON.stringify(missing)} letterWords=${letterWords} faithfulness=${score}/5`);
  if (hardFail) console.log("  grader notes:", gtext.slice(0, 600).replace(/\n/g, " | "));
  await fs.mkdir("eval-out", { recursive: true });
  await fs.writeFile(`eval-out/${f.replace(".json", ".md")}`, markdown);
}
console.log(`\n${files.length - failed}/${files.length} passed. Outputs in eval-out/.`);
process.exit(failed ? 1 : 0);
