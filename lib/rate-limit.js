// Tiny in-memory per-IP rate limiter (single instance). Use Redis-backed limits if you scale out.
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (now - h.start > windowMs) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || "unknown";
    let h = hits.get(ip);
    if (!h || now - h.start > windowMs) {
      h = { start: now, count: 0 };
      hits.set(ip, h);
    }
    if (++h.count > max) {
      res.set("Retry-After", String(Math.ceil((h.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Please wait a few minutes and try again." });
    }
    next();
  };
}
