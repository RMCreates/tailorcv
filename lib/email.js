// Transactional email through Resend's HTTP API (https://resend.com). Optional:
// without RESEND_API_KEY nothing is sent and the app works exactly the same.
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || "TailorCV <noreply@YOURDOMAIN.com>";

export const emailEnabled = () => Boolean(KEY);

async function send({ to, subject, text }) {
  if (!KEY || !to) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return true;
}

export function sendResultReady({ to, url }) {
  return send({
    to,
    subject: "Your tailored resume and cover letter are ready",
    text: `Your documents are ready. Open them here (the link works for 30 days):\n\n${url}\n\nReview everything before you send it. The writing is AI-generated from your own resume, so double-check names, dates and numbers.\n\nGood luck with the application.\nTailorCV`,
  });
}

export function sendPackCode({ to, code, credits, url }) {
  return send({
    to,
    subject: `Your TailorCV credit code (${credits} credits)`,
    text: `Thanks for your purchase. Your credit code is:\n\n${code}\n\nUse it at ${url} — paste it under "Have a credit code?". Keep this email: the code is the only way to use your credits.\n\nTailorCV`,
  });
}
