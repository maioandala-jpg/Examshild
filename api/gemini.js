/* ExamShield — função serverless (Vercel). As chaves vivem só em variáveis de ambiente.
   Variáveis: GEMINI_KEY_1 (obrigatória), GEMINI_KEY_2 (reserva), EXAMSHIELD_CODE (código dos professores),
   GEMINI_MODEL (opcional, padrão gemini-2.5-flash). */
const crypto = require('crypto');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const hits = new Map();
let turn = 0;

const limited = ip => {
  const n = Date.now(), w = (hits.get(ip) || []).filter(t => n - t < 60000);
  w.push(n); hits.set(ip, w); if (hits.size > 500) hits.clear();
  return w.length > 20;
};
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function prompt(q, disc, turma) {
  return `És um revisor pedagógico. Disciplina: ${disc || 'não indicada'}; turma: ${turma || 'não indicada'}.
Reescreve a questão de prova abaixo para ficar clara, sem ambiguidade e gramaticalmente correta, mantendo o mesmo objetivo de aprendizagem, o mesmo nível de dificuldade e o português europeu.
Regras:
- Não reveles nem insiras a resposta.
- Se for de escolha múltipla, mantém exatamente uma alternativa correta, com distratores plausíveis e 3 a 5 alternativas.
- Para ligar a questão à aula, podes abrir com uma frase de contexto, mas NUNCA inventes dados: usa campos como [[data]], [[valor medido]], [[exemplo da aula]] para o professor preencher.
- Responde SÓ com JSON: {"text":"...","opts":["..."],"nota":"uma frase a dizer o que melhoraste"}. Usa "opts":[] se a questão for aberta.
QUESTÃO:
${q.text}
${q.opts.map((o, j) => `${'abcde'[j]}) ${o}`).join('\n')}`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const code = process.env.EXAMSHIELD_CODE;
  const keys = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2].filter(Boolean);
  if (!code || !keys.length) return res.status(500).json({ error: 'Servidor sem configuração: defina EXAMSHIELD_CODE e GEMINI_KEY_1.' });

  let b = req.body;
  try { if (typeof b === 'string') b = JSON.parse(b); } catch (e) { b = null; }
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'Pedido inválido.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '?';
  if (limited(ip)) return res.status(429).json({ error: 'Muitos pedidos. Aguarde um minuto.' });
  if (!same(b.code || '', code)) return res.status(401).json({ error: 'Código do professor incorreto.' });

  const q = {
    text: str(b.q && b.q.text, 1500),
    opts: (Array.isArray(b.q && b.q.opts) ? b.q.opts : []).slice(0, 5).map(o => str(o, 300)),
  };
  if (!q.text) return res.status(400).json({ error: 'Questão vazia.' });

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt(q, str(b.disc, 60), str(b.turma, 30)) }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      ...(/2\.5-flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });

  // Alterna a chave inicial (reparte a quota) e, se falhar, tenta a seguinte.
  const start = turn++ % keys.length;
  let last = 'erro';
  for (let t = 0; t < keys.length; t++) {
    const k = keys[(start + t) % keys.length];
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
        body,
        signal: AbortSignal.timeout(keys.length > 1 ? 4500 : 9000),
      });
      if (!r.ok) { last = 'HTTP ' + r.status; continue; }
      const j = await r.json();
      const tx = (((j.candidates || [])[0] || {}).content || {}).parts;
      const o = JSON.parse((tx || []).map(p => p.text || '').join('').replace(/```json|```/g, '').trim());
      if (typeof o.text !== 'string' || !o.text.trim()) { last = 'resposta inválida'; continue; }
      return res.status(200).json({
        text: o.text.trim().slice(0, 1500),
        opts: (Array.isArray(o.opts) ? o.opts : []).map(String).slice(0, 5),
        nota: String(o.nota || '').slice(0, 300),
      });
    } catch (e) {
      last = e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha';
    }
  }
  return res.status(502).json({ error: `O assistente está indisponível (${last}). Tente novamente.` });
};
