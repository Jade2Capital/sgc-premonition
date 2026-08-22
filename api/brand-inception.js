export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { brandA, brandB } = req.body;

  if (!brandA || !brandB) {
    return res.status(400).json({ error: "Missing brandA or brandB" });
  }

  return res.status(200).json({
    plan: `Temporary response comparing ${brandA} and ${brandB}.`,
    tier: "Test Mode",
    price: "0.00"
  });
}
