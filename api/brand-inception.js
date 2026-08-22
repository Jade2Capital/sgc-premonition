import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { brandA, brandB } = req.body;

    if (!brandA || !brandB) {
      return res.status(400).json({ error: "Missing brand inputs" });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are SGC Premonition. Perform a comparative brand analysis."
        },
        {
          role: "user",
          content: `Compare these two brands:\nBrand A: ${brandA}\nBrand B: ${brandB}`
        }
      ]
    });

    return res.status(200).json({
      plan: completion.choices[0].message.content,
      price: "9.99",
      tier: "Brand Inception"
    });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
