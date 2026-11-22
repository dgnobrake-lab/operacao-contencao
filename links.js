// ===================== LINKS DE TESTE COM REVOGAÇÃO =====================
// Quem abre o jogo precisa de um link de teste ATIVO. A conferência é feita aqui no servidor:
//   GET /t/<código>  -> confere no banco; se ativo, conta o acesso, grava um cookie assinado e manda para o jogo
//   GET /            -> só entrega o jogo com cookie de um link que AINDA está ativo (revogou = bloqueia na hora)
//   WebSocket/sala   -> entrar numa partida também exige link ativo (onAuth da sala)
// Painel do administrador: /adm (senha em variável de ambiente; nada de senha ou token no HTML).
// Banco: PostgreSQL (DATABASE_URL). Sem DATABASE_URL o controle fica DESLIGADO e o jogo abre como antes.
const crypto = require('crypto');

const LIGADO = !!process.env.DATABASE_URL;
const SEGREDO = process.env.SESSAO_SEGREDO || crypto.randomBytes(32).toString('hex');   // assina os cookies
const ADMIN_SENHA = process.env.ADMIN_SENHA || '';
const COOKIE_JOGO = 'oc_teste', COOKIE_ADM = 'oc_adm';
const ADM_HORAS = 12;

let pool = null;
if (LIGADO) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)|host=\/|\?host=/.test(url) || /dpg-[a-z0-9]+-a(\/|$|:)/.test(url);   // rede interna do Render não usa SSL
  pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
}

async function prepara() {
  if (!LIGADO) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS oc_rodadas (
    id SERIAL PRIMARY KEY, nome TEXT NOT NULL, criada_em TIMESTAMPTZ NOT NULL DEFAULT now(), encerrada_em TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS oc_links (
    id TEXT PRIMARY KEY, rotulo TEXT NOT NULL DEFAULT '', rodada_id INTEGER REFERENCES oc_rodadas(id),
    estado TEXT NOT NULL DEFAULT 'ativo' CHECK (estado IN ('ativo','revogado')),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(), revogado_em TIMESTAMPTZ,
    acessos INTEGER NOT NULL DEFAULT 0, ultimo_acesso TIMESTAMPTZ)`);
  const r = await pool.query('SELECT count(*)::int AS n FROM oc_rodadas');
  if (!r.rows[0].n) await pool.query("INSERT INTO oc_rodadas(nome) VALUES ('Rodada 1')");
}

// ---------- assinatura de cookies (HMAC) ----------
const assina = (v) => v + '.' + crypto.createHmac('sha256', SEGREDO).update(v).digest('base64url');
function confere(s) {
  if (!s || typeof s !== 'string') return null;
  const i = s.lastIndexOf('.'); if (i < 1) return null;
  const v = s.slice(0, i), esp = assina(v);
  const a = Buffer.from(esp), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return v;
}
function cookies(req) {
  const o = {}; const h = (req.headers && req.headers.cookie) || '';
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
function poeCookie(res, nome, valor, maxS, sameSite) {
  res.append('Set-Cookie', `${nome}=${encodeURIComponent(valor)}; Path=/; HttpOnly; Secure; SameSite=${sameSite || 'Lax'}; Max-Age=${maxS}`);
}

// ---------- links ----------
const cache = new Map();   // id -> {ativo, t}: evita ir ao banco a cada arquivo; 5 s no máximo de atraso na revogação
async function ativo(id) {
  if (!LIGADO) return true;
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return false;
  const c = cache.get(id); if (c && Date.now() - c.t < 5000) return c.ativo;
  const r = await pool.query("SELECT estado FROM oc_links WHERE id=$1", [id]);
  const ok = !!(r.rows[0] && r.rows[0].estado === 'ativo');
  cache.set(id, { ativo: ok, t: Date.now() }); return ok;
}
const linkDoPedido = (req) => confere(cookies(req)[COOKIE_JOGO]);
async function autorizado(req) { if (!LIGADO) return true; try { return await ativo(linkDoPedido(req)); } catch (e) { console.error('[links]', e.message); return false; } }

const bloqueio = (res) => res.status(403).type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operação Contenção — acesso de teste</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f13;color:#e8eef2;font:16px "Segoe UI",Arial,sans-serif;text-align:center;padding:24px}div{max-width:420px}b{display:block;font-size:20px;margin-bottom:10px;color:#ffd24a}</style></head>
<body><div><b>Link de teste inválido ou encerrado</b>Este acesso à versão de testes não está mais ativo. Peça um link novo ao responsável pelos testes.</div></body></html>`);

// ---------- administrador ----------
const tentativas = new Map();   // ip -> {n, t}: freio contra adivinhar a senha
function admOk(req) {
  const v = confere(cookies(req)[COOKIE_ADM]); if (!v) return false;
  const [tipo, exp] = v.split(':'); return tipo === 'adm' && +exp > Date.now();
}
const exigeAdm = (req, res, next) => {
  if (!admOk(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (req.method !== 'GET' && req.get('x-oc-adm') !== '1') return res.status(403).json({ erro: 'cabecalho' });   // contra envio por outro site
  next();
};

function instala(app, express, painelHtml) {
  // entrada pelo link de teste
  app.get('/t/:id', async (req, res) => {
    if (!LIGADO) return res.redirect(302, '/');
    try {
      const id = String(req.params.id || '');
      if (!(await ativo(id))) return bloqueio(res);
      await pool.query('UPDATE oc_links SET acessos=acessos+1, ultimo_acesso=now() WHERE id=$1', [id]);
      poeCookie(res, COOKIE_JOGO, assina(id), 30 * 24 * 3600, 'Lax');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, '/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
    } catch (e) { console.error('[links]', e.message); res.status(500).send('erro'); }
  });

  // o jogo (página inicial e o próprio arquivo) só com link ativo — inclusive pelos caminhos antigos
  const protegido = (p) => p === '/' || /\.html?$/i.test(p) && !/^\/compartilhar\.html$/i.test(p);
  app.use(async (req, res, next) => {
    if (!LIGADO || !protegido(req.path)) return next();
    if (await autorizado(req)) { res.setHeader('Cache-Control', 'private, no-store'); return next(); }
    return bloqueio(res);
  });

  // painel
  app.get('/adm', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Frame-Options', 'DENY'); res.type('html').send(painelHtml); });
  app.use('/adm/api', express.json({ limit: '10kb' }));
  app.post('/adm/api/entrar', (req, res) => {
    const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
    const t = tentativas.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - t.t > 15 * 60000) { t.n = 0; t.t = Date.now(); }
    if (t.n >= 8) return res.status(429).json({ erro: 'muitas_tentativas' });
    const s = String((req.body && req.body.senha) || '');
    const a = crypto.createHash('sha256').update(s).digest(), b = crypto.createHash('sha256').update(ADMIN_SENHA).digest();
    if (!ADMIN_SENHA || !crypto.timingSafeEqual(a, b)) { t.n++; tentativas.set(ip, t); return res.status(401).json({ erro: 'senha' }); }
    tentativas.delete(ip);
    poeCookie(res, COOKIE_ADM, assina('adm:' + (Date.now() + ADM_HORAS * 3600000)), ADM_HORAS * 3600, 'Strict');
    res.json({ ok: true });
  });
  app.post('/adm/api/sair', (req, res) => { poeCookie(res, COOKIE_ADM, '', 0, 'Strict'); res.json({ ok: true }); });
  app.get('/adm/api/estado', exigeAdm, async (req, res) => {
    if (!LIGADO) return res.json({ ligado: false, links: [], rodadas: [] });
    const L = (await pool.query('SELECT l.*, r.nome AS rodada FROM oc_links l LEFT JOIN oc_rodadas r ON r.id=l.rodada_id ORDER BY l.criado_em DESC')).rows;
    const R = (await pool.query(`SELECT r.*, count(l.id)::int AS links, count(l.id) FILTER (WHERE l.estado='ativo')::int AS ativos,
      coalesce(sum(l.acessos),0)::int AS acessos FROM oc_rodadas r LEFT JOIN oc_links l ON l.rodada_id=r.id GROUP BY r.id ORDER BY r.id DESC`)).rows;
    res.json({ ligado: true, links: L, rodadas: R });
  });
  app.post('/adm/api/links', exigeAdm, async (req, res) => {
    const rot = String((req.body && req.body.rotulo) || '').slice(0, 60);
    let rid = parseInt(req.body && req.body.rodada, 10);
    if (!rid) { const r = await pool.query('SELECT id FROM oc_rodadas WHERE encerrada_em IS NULL ORDER BY id DESC LIMIT 1'); rid = r.rows[0] && r.rows[0].id; }
    const rr = await pool.query('SELECT encerrada_em FROM oc_rodadas WHERE id=$1', [rid]);
    if (!rr.rows[0]) return res.status(400).json({ erro: 'sem_rodada' });
    if (rr.rows[0].encerrada_em) return res.status(400).json({ erro: 'rodada_encerrada' });
    const id = crypto.randomBytes(24).toString('base64url');   // 192 bits aleatórios: não dá para adivinhar
    await pool.query('INSERT INTO oc_links(id, rotulo, rodada_id) VALUES ($1,$2,$3)', [id, rot, rid]);
    res.json({ ok: true, id });
  });
  app.post('/adm/api/links/:id/revogar', exigeAdm, async (req, res) => {
    const r = await pool.query("UPDATE oc_links SET estado='revogado', revogado_em=now() WHERE id=$1 AND estado='ativo' RETURNING id", [req.params.id]);
    cache.delete(req.params.id); res.json({ ok: !!r.rowCount });
  });
  app.post('/adm/api/rodadas', exigeAdm, async (req, res) => {
    const nome = String((req.body && req.body.nome) || '').slice(0, 60) || ('Rodada ' + new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
    const r = await pool.query('INSERT INTO oc_rodadas(nome) VALUES ($1) RETURNING id', [nome]); res.json({ ok: true, id: r.rows[0].id });
  });
  app.post('/adm/api/rodadas/:id/encerrar', exigeAdm, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const L = await cli.query("UPDATE oc_links SET estado='revogado', revogado_em=now() WHERE rodada_id=$1 AND estado='ativo' RETURNING id", [id]);
      await cli.query('UPDATE oc_rodadas SET encerrada_em=coalesce(encerrada_em, now()) WHERE id=$1', [id]);
      await cli.query('COMMIT');
      for (const x of L.rows) cache.delete(x.id);
      res.json({ ok: true, revogados: L.rowCount });
    } catch (e) { await cli.query('ROLLBACK'); res.status(500).json({ erro: 'falha' }); } finally { cli.release(); }
  });
}

// para a sala: entrar numa partida também exige link ativo (cookie enviado no pedido de entrada)
async function autorizaSala(context) {
  if (!LIGADO) return true;
  try { const h = (context && context.headers) || {}; return await ativo(confere(cookies({ headers: h })[COOKIE_JOGO])); } catch (e) { return false; }
}

module.exports = { LIGADO, prepara, instala, autorizaSala, ativo };
