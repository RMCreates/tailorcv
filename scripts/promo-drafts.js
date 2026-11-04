// Promo drafting bot: writes a week of platform-specific posts for YOU to review and publish.
// It never posts anything itself. Usage:
//   ANTHROPIC_API_KEY=... SITE_URL=https://yourdomain.com node scripts/promo-drafts.js [days=7]
// Output: promo/drafts-YYYY-MM-DD.md
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";

const SITE = process.env.SITE_URL || "https://YOURDOMAIN.com";
const DAYS = Number(process.argv[2] || 7);
const client = new Anthropic();

const SYSTEM = `You write marketing content for TailorCV (${SITE}), a pay-per-use web tool: a job seeker pastes their resume and a job posting, pays $9 (or 5 for $29), and gets the resume rewritten for that posting (ATS keywords, stronger bullets, never invented facts) plus a matching cover letter.
Free resources on the site: role-specific resume guides at ${SITE}/resume/ (software engineer, nurse, teacher, data analyst, product manager and 25 more).

Rules:
- Lead with genuinely useful job-search advice. Most posts should be valuable even if nobody clicks. At most 1 in 3 posts mentions TailorCV, and then plainly, disclosing it's the poster's own product.
- No fake testimonials, invented statistics, fake urgency, or claims of guaranteed interviews.
- Match each platform's native style and length.
- For Reddit: write as helpful comment/post drafts for job-search subreddits; never mention the product in the body unless the subreddit allows self-promotion — flag which ones in a note.`;

const PROMPT = `Create a ${DAYS}-day content plan. For each day give:
### Day N
- **LinkedIn post** (150-250 words, a concrete tip; hook first line)
- **X/Twitter thread** (4-6 short tweets)
- **TikTok / Reels / Shorts script** (30-45s: hook, 3 beats, call to action; include on-screen text)
- **Reddit-style helpful answer** (to a realistic question someone in r/resumes or r/jobs might ask; no product link)
- **Pinterest pin** (title + 1-sentence description + which /resume/ guide to link)
Vary topics across: ATS keywords, tailoring per job, bullet-point formulas, cover-letter openers, career changers, new grads, gaps in employment, specific roles from the guides.`;

const stream = client.beta.messages.stream({
  model: "claude-opus-5-5",
  max_tokens: 64000,
  output_config: { effort: "medium" },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: SYSTEM,
  messages: [{ role: "user", content: PROMPT }],
});
const msg = await stream.finalMessage();
if (msg.stop_reason === "refusal") throw new Error("Request declined.");
const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
await fs.mkdir("promo", { recursive: true });
const file = `promo/drafts-${new Date().toISOString().slice(0, 10)}.md`;
await fs.writeFile(file, `# TailorCV promo drafts (review before posting)\n\n${text}\n`);
console.log(`Wrote ${file} (${msg.usage.output_tokens} output tokens)`);
