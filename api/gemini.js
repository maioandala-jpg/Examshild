/* ExamShield — função serverless (Vercel). As chaves vivem só em variáveis de ambiente.
   Variáveis: GEMINI_KEY_1 (obrigatória), GEMINI_KEY_2 (reserva),
   EXAMSHIELD_CODE (opcional: código dos professores; sem ele o assistente fica aberto),
   GEMINI_MODEL (opcional, padrão gemini-2.5-flash).
   Dois modos: melhorar uma questão (padrão) e criar uma variante da prova (mode:"variant"). */
const crypto = require('crypto');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const hits = new Map();
let turn = 0;

const limited = (ip, max) => {
  const n = Date.now(), w = (hits.get(ip) || []).filter(t => n - t < 60000);
  w.push(n); hits.set(ip, w); if (hits.size > 500) hits.clear();
  return w.length > max;
};
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function improvePrompt(q, disc, turma) {
  return `És um revisor pedagógico. Disciplina: ${disc || 'não indicada'}; turma: ${turma || 'não indicada'}.
Reescreve a questão de prova abaixo para ficar clara, sem ambiguidade e gramaticalmente correta, mantendo o mesmo objetivo de aprendizagem, o mesmo nível de dificuldade e o português europeu.
Regras:
- Não reveles nem insiras a resposta.
- Se for de escolha múltipla, mantém exatamente uma alternativa correta, com distratores plausíveis e 3 a 5 alternativas.
- Para ligar a questão à aula, podes abrir com uma frase de contexto, mas NUNCA inventes dados: usa campos como [[data]], [[valor medido]], [[exemplo da aula]] para o professor preencher.
- Preserva exatamente, sem resolver nem alterar, os campos de variável como {a}, {b}, {c}, {a:2-9} e {=a*b}.
- Responde SÓ com JSON: {"text":"...","opts":["..."],"nota":"uma frase a dizer o que melhoraste"}. Usa "opts":[] se a questão for aberta.
QUESTÃO:
${q.text}
${q.opts.map((o, j) => `${'abcde'[j]}) ${o}`).join('\n')}`;
}

function variantPrompt(exam, letter, prev, disc, turma) {
  return `És professor${disc ? ' de ' + disc : ''}${turma ? ' (turma ' + turma + ')' : ''}. Cria a VERSÃO ${letter} das questões abaixo, para uma prova paralela.
Regras:
- Mantém o mesmo número de questões, a mesma ordem, o mesmo tipo (escolha múltipla ou resposta aberta), o mesmo objetivo de aprendizagem e o mesmo nível de dificuldade.
- Mantém o estilo de escrita do professor (tom, vocabulário, extensão). Muda o tema, o contexto, os exemplos, os nomes e os números. Não copies enunciados.
- Escolha múltipla: exatamente uma alternativa correta e distratores plausíveis, com o mesmo número de alternativas.
- Confere os cálculos com cuidado.
- Texto simples, sem markdown: questões numeradas "1.", alternativas "a)", e depois de cada questão uma linha "Resposta: ..." (a letra certa nas de escolha múltipla; o valor, a fórmula ou uma frase curta nas abertas).
- Se houver variáveis como {a:2-9}, {a} ou {=a*b} (só a, b, c), mantém e adapta-as com a mesma sintaxe.${prev ? '\n- A versão deve ser também diferente destas questões já criadas:\n' + prev : ''}
- Responde SÓ com JSON: {"text":"..."}
QUESTÕES ORIGINAIS:
${exam}`;
}

const mkBody = (text, maxTokens) => JSON.stringify({
  contents: [{ role: 'user', parts: [{ text }] }],
  generationConfig: {
    temperature: 0.5,
    maxOutputTokens: maxTokens,
    responseMimeType: 'application/json',
    ...(/2\.5-flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  },
});

// Alterna a chave inicial (reparte a quota); se falhar, tenta a seguinte dentro de ~9 s (limite do plano grátis).
async function callModel(keys, body, cap) {
  const deadline = Date.now() + 9000, start = turn++ % keys.length;
  let last = 'erro';
  for (let t = 0; t < keys.length; t++) {
    const ms = Math.min(cap, deadline - Date.now());
    if (ms < 1200) break;
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[(start + t) % keys.length] },
        body,
        signal: AbortSignal.timeout(ms),
      });
      if (!r.ok) { last = 'HTTP ' + r.status; continue; }
      const j = await r.json();
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts;
      const tx = (parts || []).map(p => p.text || '').join('').replace(/```json|```/g, '').trim();
      return { obj: JSON.parse(tx) };
    } catch (e) {
      last = e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha';
    }
  }
  return { error: last };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const code = process.env.EXAMSHIELD_CODE || '';
  const keys = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2].filter(Boolean);
  if (!keys.length) return res.status(500).json({ error: 'Servidor sem configuração: defina GEMINI_KEY_1 nas variáveis de ambiente.' });

  let b = req.body;
  try { if (typeof b === 'string') b = JSON.parse(b); } catch (e) { b = null; }
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'Pedido inválido.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '?';
  if (limited(ip, code ? 30 : 12)) return res.status(429).json({ error: 'Muitos pedidos. Aguarde um minuto.' });
  if (code && !same(b.code || '', code)) return res.status(401).json({ error: 'Código do professor incorreto.' });

  const disc = str(b.disc, 60), turma = str(b.turma, 30);

  if (b.mode === 'variant') {
    const exam = str(b.exam, 3000), letter = /^[BC]$/.test(b.letter) ? b.letter : 'B';
    if (!exam) return res.status(400).json({ error: 'Prova vazia.' });
    const r = await callModel(keys, mkBody(variantPrompt(exam, letter, str(b.prev, 3000), disc, turma), 3000), 8000);
    const t = r.obj && typeof r.obj.text === 'string' ? r.obj.text.replace(/\*\*/g, '').trim() : '';
    if (!t) return res.status(502).json({ error: `O assistente está indisponível (${r.error || 'resposta inválida'}). Tente novamente.` });
    return res.status(200).json({ text: t.slice(0, 3500) });
  }

  const q = {
    text: str(b.q && b.q.text, 1500),
    opts: (Array.isArray(b.q && b.q.opts) ? b.q.opts : []).slice(0, 5).map(o => str(o, 300)),
  };
  if (!q.text) return res.status(400).json({ error: 'Questão vazia.' });
  const r = await callModel(keys, mkBody(improvePrompt(q, disc, turma), 1200), keys.length > 1 ? 4500 : 9000);
  const o = r.obj;
  if (!o || typeof o.text !== 'string' || !o.text.trim()) return res.status(502).json({ error: `O assistente está indisponível (${r.error || 'resposta inválida'}). Tente novamente.` });
  return res.status(200).json({
    text: o.text.trim().slice(0, 1500),
    opts: (Array.isArray(o.opts) ? o.opts : []).map(String).slice(0, 5),
    nota: String(o.nota || '').slice(0, 300),
  });
};
