const DAILY_LIMIT = 3;
const UNLOCK_BONUS = 3;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    "unknown";

  const safeIp = ip.replace(/[^a-zA-Z0-9._-]/g, "_");
  const today = new Date().toISOString().slice(0, 10);
  const countKey = "riq:" + safeIp + ":" + today;
  const bonusKey = "riq:bonus:" + safeIp + ":" + today;

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Helper: call Upstash REST API
  async function redis(command, ...args) {
    const body = JSON.stringify([command, ...args]);
    const r = await fetch(UPSTASH_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + UPSTASH_TOKEN,
        "Content-Type": "application/json",
      },
      body,
    });
    const data = await r.json();
    return data.result;
  }

  async function get(key) {
    return await redis("GET", key);
  }

  async function set(key, value, exSecs) {
    return await redis("SET", key, value, "EX", exSecs);
  }

  try {
    const { prompt, action } = req.body;

    // Share unlock
    if (action === "unlock_share") {
      const alreadyUnlocked = await get(bonusKey);
      if (alreadyUnlocked) {
        return res.status(200).json({ success: true, message: "already_unlocked", bonus: UNLOCK_BONUS });
      }
      await set(bonusKey, 1, 86400);
      return res.status(200).json({ success: true, message: "unlocked", bonus: UNLOCK_BONUS });
    }

    // Check limit
    const currentCount = parseInt(await get(countKey)) || 0;
    const hasBonus = await get(bonusKey);
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
    await set(countKey, newCount, secs);

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
      await set(countKey, currentCount, secs); // refund
      const err = await response.json();
      return res.status(response.status).json({
        error: "AI analysis failed. Please try again.",
        detail: (err && err.error && err.error.message) || "Unknown error",
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
    return res.status(500).json({ error: "Server error: " + err.message });
  }
};

function getSecsUntilMidnight() {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.floor((midnight - new Date()) / 1000);
}

function getNextMidnight() {
  const m = new Date();
  m.setUTCHours(24, 0, 0, 0);
  return m.toISOString();
}
