import OpenAI from "openai";

export const config = {
  maxDuration: 60
};

const TIER = "Brand Inception";
const PRICE = 9.99;
const SYSTEM_PROMPT =
  "You are SGC Premonition. Perform a comparative brand analysis.";

function readBody(req) {
  let raw;
  try {
    raw = req.body;
  } catch {
    return null;
  }
  if (raw === undefined || raw === null || raw === "") return {};
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const body = readBody(req);
    if (body === null) {
      return res.status(400).json({
        ok: false,
        error: "Invalid JSON body. Send Content-Type: application/json with valid JSON."
      });
    }

    const brandA = typeof body.brandA === "string" ? body.brandA.trim() : "";
    const brandB = typeof body.brandB === "string" ? body.brandB.trim() : "";

    if (!brandA || !brandB) {
      return res.status(400).json({ ok: false, error: "Missing brand inputs" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "Server misconfigured: OPENAI_API_KEY is not set"
      });
    }

    const client = new OpenAI({ apiKey, timeout: 45000, maxRetries: 1 });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "Compare these two brands:\nBrand A: " +
            brandA +
            "\nBrand B: " +
            brandB
        }
      ]
    });

    const plan = completion?.choices?.[0]?.message?.content ?? "";

    return res.status(200).json({
      ok: true,
      tier: TIER,
      price: PRICE,
      currency: "USD",
      brandA,
      brandB,
      plan
    });
  } catch (error) {
    const detail = {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      status: error?.status ?? null,
      code: error?.code ?? null
    };
    console.error("brand-inception failed:", detail, error?.stack ?? "");

    const upstream = Number.isInteger(error?.status) ? error.status : 500;
    const status = upstream >= 400 && upstream <= 599 ? upstream : 500;

    const payload = { ok: false, error: "Internal Server Error" };
    if (process.env.DEBUG_ERRORS === "1") payload.detail = detail;

    try {
      return res.status(status).json(payload);
    } catch {
      return;
    }
  }
}
