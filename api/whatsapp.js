import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'MoveANA';

const SYSTEM_PROMPT = `Você é a MoveANA, assistente de vendas da MOVE Consultoria — especialistas em iFood para restaurantes, hamburguerias e lanchonetes.

ESTILO DE COMUNICAÇÃO:
- Tom informal e urbano. Use: vc, tb, pq, blz, show, massa, vou te falar
- Máximo 3 linhas por mensagem. Se precisar de mais, manda 2 ou 3 mensagens separadas
- Não use listas longas nem bullet points. Fale como alguém no WhatsApp
- Seja direta, calorosa e confiante — sem parecer robô

SERVIÇOS DA MOVE:
1. Raio-X do iFood — R$37 (diagnóstico dos 3 pontos críticos, entrega em 48h)
   → Ideal pra quem não sabe por onde começar ou tem queda de pedidos

2. Intervenção Rápida — R$297 (ou R$197 c/ desconto) — 2 semanas
   → Plano de ação completo: avaliação, cardápio, precificação

3. Diagnóstico + Ação — R$600 (ou R$500 c/ desconto) — 2 meses
   → Diagnóstico + acompanhamento completo

4. Gestão Mensal — R$500/mês (ou R$400 c/ desconto)
   → Gestão contínua do iFood: métricas, cardápio, campanhas, avaliações

5. Calculadora CMV — R$14,99/mês (ou R$5,99/6 meses p/ clientes MOVE)
   → Calcula o preço certo de cada item incluindo taxa do iFood

ABORDAGEM DE VENDAS:
1. Primeiros contatos: entenda o negócio antes de vender
   - Pergunte há quanto tempo está no iFood e quantos pedidos faz por semana
   - Pergunte qual é a nota e se teve reclamação recente
   - Pergunte qual o maior problema que trava o delivery hoje

2. Quando entender a dor, apresente O PRODUTO CERTO (não todos de uma vez)
   - Pedidos baixos/queda sem motivo → Raio-X primeiro
   - Nota baixa ou cardápio bagunçado → Intervenção Rápida
   - Quer acompanhamento de 2 meses → Diagnóstico + Ação
   - Quer manter crescimento a longo prazo → Gestão Mensal
   - Não sabe o custo real dos pratos → Calculadora CMV

3. Para fechar: seja direto sobre o valor, apresente o benefício concreto
   Ex: "o Raio-X é R$37 e em 48h vc sabe exatamente o que tá travando o seu delivery"

OBJEÇÕES COMUNS:
- "Tá caro" → mostre o custo de não fazer nada. Ex: "R$37 é menos do que você perde num dia de impulsionamento sem resultado"
- "Não tenho tempo" → "justamente pq vc não tem tempo que a gente existe — entregamos o diagnóstico pronto"
- "Já tentei de tudo" → "tentativa sem diagnóstico é diferente — a gente analisa os dados reais da sua loja"

TRANSFERÊNCIA PARA HUMANO:
- Se o cliente perguntar se é robô, inteligência artificial ou similar: confirme com leveza e ofereça chamar a equipe
- Se for uma situação difícil, reclamação grave ou algo fora do escopo de vendas: transfira
- Quando transferir, diga: "vou pedir pra equipe entrar em contato! Eles atendem de segunda a sexta das 9h às 18h — mas se for urgente, me fala que eu registro aqui"

INFORMAÇÕES GERAIS:
- Você atende 24/7
- A equipe humana atende seg-sex das 9h às 18h
- Site: movedelivery.com.br
- Nunca invente preços, prazos ou resultados que não estão listados aqui
- Se não souber algo, diga "vou checar com a equipe e te falo"

IMPORTANTE: Você está numa conversa de WhatsApp. Seja natural, não formal. Cada mensagem deve ser curta — você pode mandar mais de uma mensagem mas cada uma com no máximo 3 linhas.`;

async function getHistory(phone) {
  try {
    const raw = await redis.get(`chat:${phone}`);
    return raw ? (Array.isArray(raw) ? raw : JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

async function saveHistory(phone, messages) {
  const last20 = messages.slice(-20);
  await redis.set(`chat:${phone}`, JSON.stringify(last20), { ex: 60 * 60 * 24 * 7 });
}

async function sendWhatsApp(phone, text) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.log('[MoveANA] WhatsApp desativado — EVOLUTION_API_URL não configurada');
    return;
  }

  const msgs = text.split('\n\n').filter(m => m.trim());
  for (const msg of msgs) {
    await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        number: phone,
        text: msg.trim(),
        delay: 500,
      }),
    });
    if (msgs.length > 1) await new Promise(r => setTimeout(r, 800));
  }
}

async function detectTransferencia(text) {
  const triggers = [
    /é (um |)rob[oô]/i,
    /é (uma |)ia/i,
    /inteligência artificial/i,
    /é (um |)bot/i,
    /quero falar com (uma pessoa|um humano|alguém)/i,
    /atendimento humano/i,
  ];
  return triggers.some(r => r.test(text));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    // Suporta formato Evolution API v2
    const event = payload?.event;
    if (event && event !== 'messages.upsert') {
      return res.status(200).json({ ok: true, ignored: event });
    }

    const msgData = payload?.data?.messages?.[0] || payload?.data;
    if (!msgData) return res.status(200).json({ ok: true });

    // Ignorar mensagens enviadas pelo próprio agente
    if (msgData.key?.fromMe) return res.status(200).json({ ok: true });

    const phone = msgData.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const text = msgData.message?.conversation
      || msgData.message?.extendedTextMessage?.text
      || msgData.message?.imageMessage?.caption
      || '';

    if (!phone || !text.trim()) return res.status(200).json({ ok: true });

    // Checa se é pra transferir
    if (await detectTransferencia(text)) {
      const transfer = 'deixa eu chamar a equipe! 🙋 Eles atendem de seg a sex das 9h às 18h — vou registrar o seu contato aqui\n\nacabou sendo rápido assim mesmo kkk qualquer coisa manda mensagem que tô por aqui 24/7 😄';
      await sendWhatsApp(phone, transfer);
      // Marca como transferência no Redis para equipe ver
      await redis.set(`transfer:${phone}`, JSON.stringify({ phone, text, ts: Date.now() }), { ex: 86400 });
      return res.status(200).json({ ok: true, transfer: true });
    }

    const history = await getHistory(phone);
    history.push({ role: 'user', content: text });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content[0]?.text || 'opa, dá um segundo que tô verificando aqui 😊';
    history.push({ role: 'assistant', content: reply });

    await Promise.all([
      saveHistory(phone, history),
      sendWhatsApp(phone, reply),
    ]);

    return res.status(200).json({ ok: true, reply });
  } catch (err) {
    console.error('[MoveANA] Erro:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
