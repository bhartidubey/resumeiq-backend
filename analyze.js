import { kv } from "@vercel/kv";

const DAILY_LIMIT = 3;
const UNLOCK_BONUS = 3;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] || "unknown";

  const safeIp = ip.replace(/[^a-zA-Z0-9._-]/g, "_");
  const today = new Date().toISOString().slice(0, 10);
  const countKey = `riq:${safeIp}:${today}`;
  const bonusKey = `riq:bonus:${safeIp}:${today}`;

  try {
    const { prompt, action } = req.body;

    // Share unlock action
    if (action === "unlock_share") {
      const alreadyUnlocked = await kv.get(bonusKey);
      if (alreadyUnlocked) {
        return res.status(200).json({ success: true, message: "already_unlocked", bonus: UNLOCK_BONUS });
      }
      await kv.set(bonusKey, 1, { ex: 86400 });
      return res.status(200).json({ success: true, message: "unlocked", bonus: UNLOCK_BONUS });
    }

    // Check limit
    const currentCount = (await kv.get(countKey)) || 0;
    const hasBonus = await kv.get(bonusKey);
    const effectiveLimit = DAILY_LIMIT + (hasBonus ? UNLOCK_BONUS : 0);

    if (currentCount >= effectiveLimit) {
      return res.status(429).json({
        error: "limit_reached",
        used: currentCount,
        limit: effectiveLimit,
        hasBonus: !!hasBonus,
        resetAt: getNextMidnight(),
      });
    }

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing or invalid prompt" });
    }
    if (prompt.length > 25000) {
      return res.status(400).json({ error: "Resume too long. Please trim to under 6000 words." });
    }

    // Increment counter
    const newCount = currentCount + 1;
    const secs = getSecsUntilMidnight();
    await kv.set(countKey, newCount, { ex: secs });

    // Call Anthropic
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      await kv.set(countKey, currentCount, { ex: secs }); // refund
      const err = await response.json();
      return res.status(response.status).json({
        error: "AI analysis failed. Please try again.",
        detail: err?.error?.message || "Unknown error",
      });
    }

    const data = await response.json();
    return res.status(200).json({
      ...data,
      _usage: {
        used: newCount,
        limit: effectiveLimit,
        remaining: effectiveLimit - newCount,
        hasBonus: !!hasBonus,
        resetAt: getNextMidnight(),
      },
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}

function getSecsUntilMidnight() {
  const now = new Date();
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.floor((midnight - now) / 1000);
}

function getNextMidnight() {
  const m = new Date();
  m.setUTCHours(24, 0, 0, 0);
  return m.toISOString();
}
