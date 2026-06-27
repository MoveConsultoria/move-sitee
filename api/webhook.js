import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import { v4 as uuidv4 } from 'uuid';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const MOVE_EMAIL = 'admconsultoriamove@gmail.com';
const FROM_EMAIL = 'contato@movedelivery.com.br';

const PRODUTOS = {
  // Raio-X
  'bd067879-58ac-4b6b-8b7a-0c68a72558c2': { nome: 'Raio-X', tipo: 'raiox' },
  // Planos de consultoria
  'f5a2c633-e2e8-4235-b126-fc834b4d7d40': { nome: 'Intervenção Rápida', tipo: 'consultoria' },
  'd058be70-251c-4c0f-a615-dd097afb875d': { nome: 'Intervenção Rápida Desconto', tipo: 'consultoria' },
  '3ac1cbc4-8aac-4331-8593-b224b374ad82': { nome: 'Plano Intermediário', tipo: 'consultoria' },
  '03cff423-6651-48c5-a73f-dcc129c2bd66': { nome: 'Plano Intermediário Desconto', tipo: 'consultoria' },
  '1f179fcd-0c53-4c25-8ad7-e21aa8285c40': { nome: 'Gestão Mensal', tipo: 'consultoria' },
  'f0bf3962-d58f-40ac-9fab-cfdd3c48af9e': { nome: 'Gestão Mensal Desconto', tipo: 'consultoria' },
  // Calculadora CMV
  '47709b02-6215-4a69-9c90-214fa2bf1fe0': { nome: 'Calculadora CMV', tipo: 'calculadora', dias: 30 },
  'fb07b6ec-f76f-4bb5-9a1e-3d00e34b4561': { nome: 'Calculadora CMV Upsell Plano', tipo: 'calculadora', dias: 180 },
};

async function gerarTokenCalculadora(email, dias) {
  const token = uuidv4();
  const expiry = Date.now() + dias * 24 * 60 * 60 * 1000;
  await redis.set(`calc_token:${token}`, JSON.stringify({ email, expiry }), { ex: dias * 86400 });
  await redis.set(`calc_email:${email}`, JSON.stringify({ token, expiry }), { ex: dias * 86400 });
  return token;
}

async function enviarEmailMOVE(clienteNome, clienteEmail, produto) {
  await resend.emails.send({
    from: FROM_EMAIL,
    to: MOVE_EMAIL,
    subject: `Nova compra: ${produto}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#1A1A1A">Nova compra recebida!</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#888">Produto</td><td style="padding:8px 0;font-weight:bold">${produto}</td></tr>
          <tr><td style="padding:8px 0;color:#888">Cliente</td><td style="padding:8px 0">${clienteNome}</td></tr>
          <tr><td style="padding:8px 0;color:#888">E-mail</td><td style="padding:8px 0">${clienteEmail}</td></tr>
        </table>
        <p style="margin-top:24px;color:#888;font-size:13px">Acesse o painel da Cakto para mais detalhes.</p>
      </div>
    `,
  });
}

async function enviarEmailCalculadora(clienteNome, clienteEmail, token, dias) {
  const url = `https://movedelivery.com.br/?calc_token=${token}`;
  const validade = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR');
  await resend.emails.send({
    from: FROM_EMAIL,
    to: clienteEmail,
    subject: 'Seu acesso à MOVE Calculadora CMV está pronto!',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#1A1A1A">Olá, ${clienteNome}!</h2>
        <p style="color:#444">Seu acesso à <strong>MOVE Calculadora CMV</strong> foi liberado com sucesso.</p>
        <div style="text-align:center;margin:32px 0">
          <a href="${url}" style="display:inline-block;padding:16px 32px;background:#EF9F27;color:#1A1A1A;font-weight:bold;font-size:16px;border-radius:10px;text-decoration:none">
            Acessar a Calculadora →
          </a>
        </div>
        <p style="color:#888;font-size:13px">
          Seu acesso é válido até <strong>${validade}</strong>.<br>
          Este link é pessoal e intransferível — não compartilhe com terceiros.
        </p>
      </div>
    `,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    const status = payload?.status
      || payload?.payment?.status
      || payload?.order?.status;

    if (!['paid', 'approved', 'completed'].includes(status)) {
      return res.status(200).json({ ok: true, msg: 'Evento ignorado' });
    }

    const produtoId = payload?.product?.id || payload?.product_id;
    const clienteNome = payload?.customer?.name || payload?.name || 'Cliente';
    const clienteEmail = payload?.customer?.email || payload?.email;

    if (!produtoId || !clienteEmail) {
      return res.status(400).json({ error: 'Dados incompletos no payload' });
    }

    const produto = PRODUTOS[produtoId];
    if (!produto) {
      return res.status(200).json({ ok: true, msg: 'Produto não mapeado' });
    }

    if (produto.tipo === 'calculadora') {
      const token = await gerarTokenCalculadora(clienteEmail, produto.dias);
      await enviarEmailCalculadora(clienteNome, clienteEmail, token, produto.dias);
    } else {
      await enviarEmailMOVE(clienteNome, clienteEmail, produto.nome);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
