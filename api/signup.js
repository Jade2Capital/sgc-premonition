export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    // Placeholder logic — replace with your real signup logic later
    return res.status(200).json({
      message: "Signup successful",
      user: { email }
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
