// ===================== SALA DA PARTIDA (servidor autoritativo) =====================
// Uma sala = uma partida, no maximo 10 jogadores. O servidor e quem manda em:
// numero de jogadores, vida, morte, renascimento, cadencia de tiro e semente do mapa.
// Posicao e animacao sao enviadas pelo dono do personagem (o jogo roda em cada aparelho)
// mas passam por limites de velocidade e de area antes de virarem estado.
const { Room } = require('@colyseus/core');
const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');

// Em casa (servidor no PC do jogador) a sala é de 2; no Render o padrão continua 10.
const MAX_JOGADORES = Math.max(2, Math.min(16, parseInt(process.env.MAX_JOGADORES || '10', 10) || 10));
const MAPA_LADO = 120;          // unidades de mundo (o mapa do jogo tem 120x120)
const VEL_MAX = 30;             // unidades/s: acima disso e teleporte (carro rapido ~14)
const TIRO_MIN_MS = 55;         // cadencia maxima aceita (a arma mais rapida do jogo)
const VIDA_CHEIA = 100;
const RESPAWN_MS = 6000;

class Jogador extends Schema {}
// os campos sao exatamente os que o jogo ja troca na rede local (x,y em tiles; g = giro; s = velocidade;
// a = mirando; c = agachado; d = caido; h = vida; v* = veiculo), para o cliente ser o mesmo nos dois modos
defineTypes(Jogador, {
  id: 'string', nome: 'string', modo: 'string', lado: 'string',
  x: 'float32', y: 'float32', g: 'float32', s: 'float32',
  a: 'uint8', c: 'uint8', d: 'uint8', h: 'uint8',
  vx: 'float32', vy: 'float32', vg: 'float32', vsub: 'string',
  arma: 'uint8', pronto: 'boolean', ping: 'uint16', baixas: 'uint16'
});

class Estado extends Schema {
  constructor() { super(); this.jogadores = new MapSchema(); }
}
defineTypes(Estado, {
  jogadores: { map: Jogador },
  semente: 'uint32', comecou: 'boolean', modo: 'string',
  codigo: 'string', max: 'uint8', dono: 'string', modalidade: 'string'
});

class SalaOperacao extends Room {
  onCreate(opcoes) {
    this.maxClients = MAX_JOGADORES;
    this.autoDispose = true;
    this.state = new Estado();
    this.state.max = MAX_JOGADORES;
    this.state.modo = (opcoes && opcoes.modo) || 'policia';
    this.state.codigo = ((opcoes && opcoes.codigo) || this.gerarCodigo()).toUpperCase().slice(0, 6);
    this.state.semente = (opcoes && +opcoes.semente) || 20261107;
    this.state.comecou = false;
    this.state.modalidade = (opcoes && opcoes.modalidade) === 'coop' ? 'coop' : '1v1';
    this.setMetadata({ codigo: this.state.codigo, modo: this.state.modo, nome: (opcoes && opcoes.salaNome) || ('Sala ' + this.state.codigo) });
    this.ultimoTiro = new Map();
    this.ultimoMover = new Map();

    this.onMessage('mover', (cliente, d) => this.aoMover(cliente, d));
    this.onMessage('tiro', (cliente, d) => this.aoTiro(cliente, d));
    this.onMessage('dano', (cliente, d) => this.aoDano(cliente, d));
    this.onMessage('renascer', (cliente) => this.renascer(cliente.sessionId));
    this.onMessage('pronto', (cliente, d) => { const j = this.state.jogadores.get(cliente.sessionId); if (j) j.pronto = !!(d && d.pronto); });
    this.onMessage('comecar', (cliente) => {
      if (cliente.sessionId !== this.state.dono) return;
      this.state.comecou = true; this.broadcast('comecou', { semente: this.state.semente, modo: this.state.modo });
    });
    this.onMessage('ping', (cliente, d) => cliente.send('pong', d));
    this.onMessage('modalidade', (cliente, d) => {
      if (cliente.sessionId !== this.state.dono || !d) return;
      this.state.modalidade = d.modalidade === 'coop' ? 'coop' : '1v1';
      this.redistribuirLados();
      this.broadcast('modalidade', { modalidade: this.state.modalidade });
    });
    this.onMessage('chat', (cliente, d) => {
      const j = this.state.jogadores.get(cliente.sessionId); if (!j || !d || !d.txt) return;
      this.broadcast('chat', { de: j.nome, txt: String(d.txt).slice(0, 120) });
    });
  }

  // 1v1: o primeiro fica com o lado que escolheu e o segundo entra do lado oposto.
  // cooperativo: os dois do mesmo lado.
  redistribuirLados() {
    const ids = [...this.state.jogadores.keys()];
    if (!ids.length) return;
    const dono = this.state.jogadores.get(this.state.dono) || this.state.jogadores.get(ids[0]);
    const ladoDono = (dono && dono.modo === 'traficante') ? 'traficante' : 'policia';
    const oposto = ladoDono === 'policia' ? 'traficante' : 'policia';
    let i = 0;
    for (const id of ids) {
      const j = this.state.jogadores.get(id);
      if (!j) continue;
      j.lado = (this.state.modalidade === 'coop') ? ladoDono : (i === 0 ? ladoDono : oposto);
      i++;
    }
  }

  gerarCodigo() {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
    for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
    return c;
  }

  // o 11o jogador e recusado aqui, com motivo (o cliente mostra "sala cheia")
  onAuth() { 
    if (this.clients.length >= MAX_JOGADORES) throw new Error('SALA_CHEIA');
    return true;
  }

  onJoin(cliente, opcoes) {
    const j = new Jogador();
    j.id = cliente.sessionId;
    j.nome = String((opcoes && opcoes.nome) || 'Jogador').slice(0, 16) || 'Jogador';
    j.modo = String((opcoes && opcoes.modo) || this.state.modo);
    j.x = 60; j.y = 60; j.g = 0; j.s = 0; j.a = 0; j.c = 0; j.d = 0; j.h = VIDA_CHEIA;
    j.vx = 0; j.vy = 0; j.vg = 0; j.vsub = ''; j.arma = 0; j.pronto = false; j.ping = 0; j.baixas = 0;
    this.state.jogadores.set(cliente.sessionId, j);
    if (!this.state.dono) this.state.dono = cliente.sessionId;
    this.redistribuirLados();
    this.broadcast('entrou', { id: cliente.sessionId, nome: j.nome, total: this.state.jogadores.size, lado: j.lado });
  }

  async onLeave(cliente, intencional) {
    const j = this.state.jogadores.get(cliente.sessionId);
    if (j) j.pronto = false;
    if (!intencional) {
      try { await this.allowReconnection(cliente, 40); return; }   // 40 s para voltar
      catch (e) { /* nao voltou */ }
    }
    this.state.jogadores.delete(cliente.sessionId);
    if (this.state.dono === cliente.sessionId) {
      const prox = this.state.jogadores.keys().next();
      this.state.dono = prox && !prox.done ? prox.value : '';
    }
    this.broadcast('saiu', { id: cliente.sessionId, total: this.state.jogadores.size });
  }

  aoMover(cliente, d) {
    const j = this.state.jogadores.get(cliente.sessionId);
    if (!j || !d) return;
    const agora = Date.now();
    let ant = this.ultimoMover.get(cliente.sessionId);
    if (!ant) {
      // primeira posicao depois de entrar: o servidor nao sabe onde o jogador esta, entao aceita.
      // (sem isto o jogador nascia preso no 60,60 para os outros: o primeiro envio parecia teleporte
      //  e todos os seguintes tambem, porque a referencia nunca avancava)
      ant = { t: agora - 1000, x: +d.x || 0, z: +d.y || 0, rej: 0 };
      this.ultimoMover.set(cliente.sessionId, ant);
    }
    const dt = Math.max(0.016, (agora - ant.t) / 1000);
    const x = Math.max(-10, Math.min(MAPA_LADO + 10, +d.x || 0));
    const y = Math.max(-10, Math.min(MAPA_LADO + 10, +d.y || 0));
    const dist = Math.hypot(x - ant.x, y - ant.z);
    if (dist / dt > VEL_MAX && dist > 2 && (ant.rej || 0) < 4) {   // salto impossivel: ignora (ate 4 seguidos)
      ant.rej = (ant.rej || 0) + 1; ant.t = agora;
      return;                                        // a referencia NAO vira a posicao do servidor
    }
    ant.rej = 0;
    j.x = x; j.y = y; j.g = +d.g || 0; j.s = +d.s || 0;
    j.a = d.a ? 1 : 0; j.c = d.c ? 1 : 0;
    if (!j.d) j.d = d.d ? 1 : 0;                      // morte quem decide e o servidor
    if (typeof d.arma === 'number') j.arma = d.arma & 255;
    if (d.v) { j.vx = +d.v.x || 0; j.vy = +d.v.y || 0; j.vg = +d.v.g || 0; j.vsub = String(d.v.s || '').slice(0, 16); }
    else j.vsub = '';
    if (typeof d.ping === 'number') j.ping = Math.min(9999, d.ping | 0);
    ant.t = agora; ant.x = x; ant.z = y;
  }

  aoTiro(cliente, d) {
    const j = this.state.jogadores.get(cliente.sessionId);
    if (!j || j.d || !d) return;
    const agora = Date.now(), ult = this.ultimoTiro.get(cliente.sessionId) || 0;
    if (agora - ult < TIRO_MIN_MS) return;           // cadencia impossivel: ignora
    this.ultimoTiro.set(cliente.sessionId, agora);
    this.broadcast('tiro', {
      de: cliente.sessionId, ox: +d.ox || 0, oy: +d.oy || 0, oz: +d.oz || 0,
      dx: +d.dx || 0, dy: +d.dy || 0, dz: +d.dz || 0, arma: (d.arma | 0) & 255
    }, { except: cliente });
  }

  // quem atira informa o acerto; o servidor e quem aplica o dano e decide a morte
  aoDano(cliente, d) {
    if (!d || !d.alvo) return;
    const atirador = this.state.jogadores.get(cliente.sessionId);
    const alvo = this.state.jogadores.get(String(d.alvo));
    if (!atirador || !alvo || alvo.d || alvo.id === atirador.id) return;
    const dano = Math.max(1, Math.min(100, d.dano | 0));
    alvo.h = Math.max(0, alvo.h - dano);
    this.broadcast('dano', { alvo: alvo.id, de: atirador.id, dano, vida: alvo.h, regiao: String(d.regiao || 'torso').slice(0, 8) });
    if (alvo.h === 0) {
      alvo.d = 1; atirador.baixas++;
      this.broadcast('morte', { alvo: alvo.id, de: atirador.id, nome: alvo.nome, porNome: atirador.nome });
      this.clock.setTimeout(() => this.renascer(alvo.id), RESPAWN_MS);
    }
  }

  renascer(id) {
    const j = this.state.jogadores.get(id);
    if (!j) return;
    j.h = VIDA_CHEIA; j.d = 0;
    this.broadcast('renasceu', { id, x: j.x, y: j.y });
  }
}

module.exports = { SalaOperacao, MAX_JOGADORES };
