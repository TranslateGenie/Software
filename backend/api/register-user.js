export function registerUserHandler(req, res) {
  const { email, plan } = req.body || {};

  if (!email || !plan) {
    return res.status(400).json({ ok: false, error: 'email and plan are required' });
  }

  const generatedKey = `MDAS-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  return res.status(201).json({
    ok: true,
    email,
    plan,
    license_key: generatedKey,
    message: 'Registration accepted. In production this endpoint should create a subscription and send an email.',
  });
}
