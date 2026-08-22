import OpenAI from "openai";

export const config = {
  runtime: "nodejs"
};

function parseBody(req) {
  const raw = req.body;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw;
  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = parseBody(req);
  const brandA = typeof body.brandA === "string" ? body.brandA.trim() : "";
  const brandB = typeof body.brandB === "string" ? body.brandB.trim() : "";

  if (!brandA || !brandB) {
    return res.status(400).json({ error: "Missing brand inputs" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: missing OPENAI_API_KEY" });
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are SGC Premonition. Perform a comparative brand analysis."
        },
        {
          role: "user",
          content: "Compare these two brands:\nBrand A: " + brandA + "\nBrand B: " + brandB
        }
      ]
    });

    const plan = completion?.choices?.[0]?.message?.content ?? "";

    return res.status(200).json({
      ok: true,
      tier: "Brand Inception",
      price: 9.99,
      currency: "USD",
      brandA,
      brandB,
      plan
    });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
