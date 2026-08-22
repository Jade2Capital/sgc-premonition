
Vercel API Backend Routes
api/brand-inception.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed"
    });
  }

  try {

    const {
      brandName,
      description,
      keywords,
      industry,
      riskIndicators
    } = req.body;

    const completion =
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a strategic brand intelligence engine. Return valid JSON only."
          },
          {
            role: "user",
            content: `
Analyze the following brand.

Brand Name: ${brandName}
Description: ${description}
Keywords: ${JSON.stringify(keywords)}
Industry: ${industry}
Risk Indicators: ${JSON.stringify(riskIndicators)}

Return JSON:

{
  "PK Intelligence":"",
  "Foresight Matrix":"",
  "Brand Score":0,
  "Summary":""
}
`
          }
        ]
      });

    const raw =
      completion.choices?.[0]?.message?.content || "{}";

    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = { raw };
    }

    return res.status(200).json({
      result
    });

  } catch (error) {

    return res.status(500).json({
      error: error.message
    });

  }
}
api/brand-org.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed"
    });
  }

  try {

    const {
      brand1,
      brand2
    } = req.body;

    const completion =
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a strategic brand comparison engine. Return valid JSON only."
          },
          {
            role: "user",
            content: `
Compare the following two brands.

BRAND 1:
${JSON.stringify(brand1,null,2)}

BRAND 2:
${JSON.stringify(brand2,null,2)}

Return JSON:

{
  "Keyword overlap":[],
  "Keyword divergence":[],
  "Risk delta":"",
  "Industry alignment":"",
  "Matrix comparison":"",
  "Alignment score":0,
  "Divergence score":0,
  "Strategic recommendations":[]
}
`
          }
        ]
      });

    const raw =
      completion.choices?.[0]?.message?.content || "{}";

    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = { raw };
    }

    return res.status(200).json({
      result
    });

  } catch (error) {

    return res.status(500).json({
      error: error.message
    });

  }
}
