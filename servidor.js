// ===================== SERVIDOR PUBLICO (um endereco so) =====================
// O mesmo processo entrega o jogo (HTML) e a partida (Colyseus por WebSocket).
// Assim o jogador abre UM link no navegador do celular e joga: nao instala nada.
//   GET  /                -> o jogo
//   GET  /saude           -> health check da hospedagem
//   GET  /salas           -> salas abertas (JSON), para a lista no jogo
//   GET  /t/<codigo>      -> link de teste (confere no banco e libera o jogo para esse navegador)
//   GET  /adm             -> painel do administrador dos links
//   WS   /                -> Colyseus
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('@colyseus/core');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { matchMaker } = require('@colyseus/core');
const { SalaOperacao, MAX_JOGADORES } = require('./sala');
const links = require('./links');   // links de teste com revogação (liga sozinho quando há DATABASE_URL)

const PORTA = process.env.PORT || 2567;
const PASTA = process.env.PASTA_JOGO || path.join(__dirname, 'publico');
const ARQUIVO_JOGO = process.env.ARQUIVO_JOGO || 'index.html';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.set('trust proxy', 1);
// links de teste: tem de vir ANTES dos arquivos (senão /index.html e / passariam sem conferir o link)
links.instala(app, express, fs.readFileSync(path.join(__dirname, 'adm', 'painel.html'), 'utf8'));

// v93: o jogo vai COMPRIMIDO (gzip, ~28% menor: 134 MB → ~96 MB) para quem aceita — ajuda celular fraco e internet ruim.
// O .gz é feito uma vez depois que o servidor sobe; até ficar pronto, vai o HTML normal.
const zlib = require('zlib');
const arqJogo = () => path.join(PASTA, ARQUIVO_JOGO);
function gzValido() { try { const a = fs.statSync(arqJogo()), g = fs.statSync(arqJogo() + '.gz'); return g.mtimeMs >= a.mtimeMs && g.size > 1000; } catch (e) { return false; } }
function preparaGz() {
  try {
    if (!fs.existsSync(arqJogo()) || gzValido()) return;
    const tmp = arqJogo() + '.gz.tmp', t0 = Date.now();
    fs.createReadStream(arqJogo()).pipe(zlib.createGzip({ level: 6 })).pipe(fs.createWriteStream(tmp))
      .on('finish', () => { try { fs.renameSync(tmp, arqJogo() + '.gz'); console.log('[gzip] jogo comprimido:', fs.statSync(arqJogo() + '.gz').size, 'bytes em', Date.now() - t0, 'ms'); } catch (e) { console.log('[gzip] erro', e.message); } })
      .on('error', e => console.log('[gzip] erro', e.message));
  } catch (e) { console.log('[gzip] erro', e.message); }
}
// v94: versão de TESTE em /teste (publico/teste.html), também comprimida
const arqTeste = () => path.join(PASTA, 'teste.html');
function gzValidoT() { try { const a = fs.statSync(arqTeste()), g = fs.statSync(arqTeste() + '.gz'); return g.mtimeMs >= a.mtimeMs && g.size > 1000; } catch (e) { return false; } }
function preparaGzT() { try { if (!fs.existsSync(arqTeste()) || gzValidoT()) return; const tmp = arqTeste() + '.gz.tmp';
  fs.createReadStream(arqTeste()).pipe(zlib.createGzip({ level: 6 })).pipe(fs.createWriteStream(tmp)).on('finish', () => { try { fs.renameSync(tmp, arqTeste() + '.gz'); console.log('[gzip] teste comprimido'); } catch (e) {} }); } catch (e) {} }
app.get(['/teste', '/teste.html'], (req, res) => {
  if (!fs.existsSync(arqTeste())) return res.status(404).type('html').send('<h2>Sem versão de teste no momento</h2>');
  res.setHeader('Cache-Control', 'no-cache');
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '') || !gzValidoT()) return res.sendFile(arqTeste());
  const gz = arqTeste() + '.gz', st = fs.statSync(gz);
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
  const etag = '"oct-' + st.size + '-' + Math.round(st.mtimeMs) + '"'; res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  res.setHeader('Content-Length', st.size); if (req.method === 'HEAD') return res.end(); fs.createReadStream(gz).pipe(res);
});
app.get(['/', '/' + ARQUIVO_JOGO], (req, res, next) => {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '') || !gzValido()) return next();
  const gz = arqJogo() + '.gz', st = fs.statSync(gz);
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
  // v93b: o HTML do jogo é SEMPRE conferido com o servidor (antes ficava 1 hora guardado no celular e a versão nova não aparecia).
  // Se não mudou, a resposta é 304 (sem baixar de novo).
  const etag = '"oc-' + st.size + '-' + Math.round(st.mtimeMs) + '"';
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('ETag', etag); res.setHeader('Last-Modified', st.mtime.toUTCString());
  if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  res.setHeader('Content-Length', st.size);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(gz).pipe(res);
});
// o HTML do jogo tem mais de 100 MB: compressao e cache valem muito aqui
app.use(express.static(PASTA, {
  maxAge: '7d', etag: true, lastModified: true,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }   // v93b: sempre confere a versão
}));

app.get('/saude', (req, res) => {
  const arq = path.join(PASTA, ARQUIVO_JOGO);
  let tamanho = null; try { tamanho = fs.statSync(arq).size; } catch (e) {}
  res.json({ ok: true, jogo: !!tamanho, bytesDoJogo: tamanho, maxJogadoresPorSala: MAX_JOGADORES, tempoDeVidaS: Math.round(process.uptime()) });
});

app.get('/salas', async (req, res) => {
  try {
    const salas = await matchMaker.query({ name: 'oc' });   // TODAS, inclusive as cheias/travadas
    res.json(salas.map(s => ({
      id: s.roomId, codigo: (s.metadata && s.metadata.codigo) || '',
      nome: (s.metadata && s.metadata.nome) || '', modo: (s.metadata && s.metadata.modo) || '',
      jogadores: s.clients, max: s.maxClients, cheia: s.clients >= s.maxClients
    })));
  } catch (e) { res.json([]); }
});

app.get('/', (req, res, next) => {
  const arq = path.join(PASTA, ARQUIVO_JOGO);
  if (fs.existsSync(arq)) return res.sendFile(arq);
  res.status(503).type('html').send('<h2>O jogo ainda nao foi colocado no servidor</h2>'
    + '<p>Rode <code>npm run baixar-jogo</code> ou envie o HTML para <code>publico/index.html</code>.</p>');
});

const servidorHttp = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: servidorHttp, maxPayload: 512 * 1024 }) });
gameServer.define('oc', SalaOperacao).filterBy(['codigo']);   // mesmo codigo = mesma sala

links.prepara().catch(e => console.error('[links] banco:', e.message)).finally(() => {
  servidorHttp.listen(PORTA, () => {
    setTimeout(preparaGz, 1500);
    setTimeout(preparaGzT, 60000);
    console.log('[OC] servidor no ar na porta ' + PORTA + ' | pasta do jogo: ' + PASTA + ' | links de teste: ' + (links.LIGADO ? 'LIGADO' : 'desligado'));
  });
});
module.exports = { app, gameServer, servidorHttp };
