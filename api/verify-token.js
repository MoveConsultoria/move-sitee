import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ valid: false, error: 'Token não informado' });
  }

  try {
    const data = await redis.get(`calc_token:${token}`);
    if (!data) {
      return res.status(200).json({ valid: false, error: 'Token inválido' });
    }

    const { expiry } = data;
    if (Date.now() > expiry) {
      return res.status(200).json({ valid: false, error: 'Token expirado' });
    }

    const diasRestantes = Math.ceil((expiry - Date.now()) / (1000 * 60 * 60 * 24));
    return res.status(200).json({ valid: true, diasRestantes });
  } catch (err) {
    console.error('Verify token error:', err);
    return res.status(500).json({ valid: false, error: 'Erro interno' });
  }
}
