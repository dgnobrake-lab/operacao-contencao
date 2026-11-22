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

// o HTML do jogo tem mais de 100 MB: compressao e cache valem muito aqui
app.use(express.static(PASTA, {
  maxAge: '7d', etag: true, lastModified: true,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=3600'); }
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
    console.log('[OC] servidor no ar na porta ' + PORTA + ' | pasta do jogo: ' + PASTA + ' | links de teste: ' + (links.LIGADO ? 'LIGADO' : 'desligado'));
  });
});
module.exports = { app, gameServer, servidorHttp };
