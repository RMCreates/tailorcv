import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM = `You are an expert career coach and professional resume writer.
You rewrite a candidate's resume so it targets one specific job posting, and you write a matching cover letter.

Rules:
- Use only facts found in the candidate's resume. Never invent employers, titles, dates, degrees, certifications, numbers or skills.
- You may reorder, reword, merge or drop content, and surface relevant experience the original undersells.
- Mirror the job posting's important keywords where the candidate's real experience supports them, so the resume passes applicant tracking systems.
- Write strong, specific bullet points that lead with an action verb and show impact.
- Keep the cover letter under 350 words, warm and specific to this company and role, with no clichés.

Reply in Markdown with exactly these three top-level sections, in this order:
## Match Summary
(3-5 bullets: how well the candidate fits, strongest selling points, and any gaps worth addressing honestly)
## Tailored Resume
## Cover Letter`;

export async function tailor({ resume, job }) {
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    output_config: { effort: "high" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `<resume>\n${resume}\n</resume>\n\n<job_posting>\n${job}\n</job_posting>`,
      },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("The request was declined. Please check your inputs and try again.");
  }
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Empty response from the model.");
  return { markdown: text, usage: message.usage };
}
