import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { brandA, brandB } = req.body;

  if (!brandA || !brandB) {
    return res.status(400).json({ error: "Missing brandA or brandB" });
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are Brand Inception, a lightweight introductory brand comparison engine."
        },
        {
          role: "user",
          content: `Provide an introductory comparison between ${brandA} and ${brandB}.`
        }
      ]
    });

    const plan = completion.choices[0].message.content;

    return res.status(200).json({
      plan,
      price: "9.99",
      tier: "Brand Inception"
    });
  } catch (error) {
    return res.status(500).json({
      error: "Internal Server Error",
      details: error.message
    });
  }
}

