// ===================== v90: PERSONAGENS EXCLUSIVOS POR PARTIDA (autoridade do servidor) =====================
// Cada sala tem o seu cadastro: skinId -> sessionId (quem está com a aparência) e idUnidade -> sessionId
// (quem está controlando aquele personagem). Tudo roda dentro do laço de mensagens da sala (Node é de uma linha
// só e o Colyseus entrega as mensagens de uma sala em ordem), então cada pedido é conferido e gravado sem que
// outro pedido possa entrar no meio: dois pedidos simultâneos pela mesma skin => só o primeiro leva.
// O skinId identifica o MODELO 3D (arquivo), não a instância: dois PMs com o mesmo modelo são a mesma skin.

const CATALOGO = {
  policia: ['policial0', 'policial1', 'policial2', 'bopecap', 'bopecar', 'bopesnp', 'sniper', 'pcdel', 'pcpla', 'pccur'],
  traficante: ['traficante', 'vandinho', 'dg', 'ruivinho', 'pz', 'moreno', 'abacaxi', 'tralha', 'palito', 'cremosinho',
    'meiovelho', 'neguinho', 'douglas', 'gilmar']
};
const TODAS = new Set([...CATALOGO.policia, ...CATALOGO.traficante]);

// mesma regra do desenho 3D do jogo (charKey): modelo próprio > traficante padrão > sniper > PM 0/1/2
// d = descrição da unidade que o jogo já troca: [id, time, sub, asset, bits, mdl, ...]
function skinDaDescricao(d) {
  if (!Array.isArray(d) || d.length < 6) return null;
  const asset = d[3], bits = d[4] | 0, mdl = d[5];
  if (asset) return String(asset);
  if (bits & 1) return 'traficante';
  const m = (mdl == null || mdl < 0) ? 0 : (mdl | 0);
  if (m === 3) return 'sniper';
  return 'policial' + (m % 3);
}

class Personagens {
  constructor(estado, log) {
    this.e = estado;            // estado sincronizado da sala (skins, posse, jogadores)
    this.skinDe = new Map();    // idUnidade -> skinId, aprendido das descrições enviadas pelo anfitrião (autoridade do mundo)
    this.log = log || (() => {});
    this.stats = { aprovados: 0, recusados: 0, liberados: 0 };
  }
  // o lado que vale é o que o jogador está JOGANDO (modo do jogo dele: polícia ou traficante); o 'lado' sugerido pela sala
  // (1v1 alternado) não é imposto ao jogo, então não pode recusar o personagem que ele de fato comanda
  lado(sid) { const j = this.e.jogadores.get(sid); if (!j) return null; if (j.modo === 'traficante' || j.modo === 'policia') return j.modo; return j.lado || 'policia'; }
  aprende(lista) { if (!Array.isArray(lista)) return; for (const d of lista) { const s = skinDaDescricao(d); if (s && d[0]) this.skinDe.set(d[0] | 0, s); } }
  donoSkin(skin) { return this.e.skins.get(skin) || ''; }
  donoUnidade(uid) { return this.e.posse.get(String(uid)) || ''; }
  minhaSkin(sid) { const j = this.e.jogadores.get(sid); return j ? (j.skin || '') : ''; }
  disponibilidade() { const o = {}; this.e.skins.forEach((sid, skin) => { o[skin] = sid; }); return o; }

  // valida e grava. Ordem segura na troca: 1) confere a nova  2) grava a nova  3) atualiza o jogador  4) solta a antiga
  reservar(sid, skin) {
    const j = this.e.jogadores.get(sid);
    if (!j) return { ok: false, motivo: 'sem_jogador' };
    skin = String(skin || '');
    if (!TODAS.has(skin)) return { ok: false, motivo: 'skin_desconhecida' };
    const lado = this.lado(sid);
    if (!CATALOGO[lado] || !CATALOGO[lado].includes(skin)) return { ok: false, motivo: 'outro_lado' };
    const dono = this.donoSkin(skin);
    if (dono && dono !== sid) return { ok: false, motivo: 'skin_ocupada', dono };
    const antiga = j.skin || '';
    this.e.skins.set(skin, sid);           // 1-2
    j.skin = skin;                          // 3
    if (antiga && antiga !== skin && this.e.skins.get(antiga) === sid) this.e.skins.delete(antiga);   // 4
    // o personagem que ele controlava tinha a aparência antiga? solta o controle (não pode ficar com duas)
    if (antiga && antiga !== skin && j.uid && this.skinDe.get(j.uid) === antiga) this.soltarUnidade(sid, j.uid);
    return { ok: true, skin, antiga };
  }

  // assumir o controle de um personagem (incorporação). A skin dele precisa estar livre ou já ser minha.
  incorporar(sid, uid, skinInformada) {
    const j = this.e.jogadores.get(sid);
    if (!j) return { ok: false, motivo: 'sem_jogador' };
    uid = uid | 0;
    if (uid <= 0) return { ok: false, motivo: 'unidade_invalida' };
    const outro = this.donoUnidade(uid);
    if (outro && outro !== sid) return { ok: false, motivo: 'unidade_ocupada', dono: outro };
    // a aparência vem do que o ANFITRIÃO descreveu; só se ele ainda não descreveu essa unidade vale a do pedido
    const skin = this.skinDe.get(uid) || String(skinInformada || '');
    const r = this.reservar(sid, skin);
    if (!r.ok) return r;
    if (j.uid && j.uid !== uid && this.e.posse.get(String(j.uid)) === sid) this.e.posse.delete(String(j.uid));
    this.e.posse.set(String(uid), sid);
    j.uid = uid;
    return { ok: true, uid, skin };
  }

  soltarUnidade(sid, uid) {
    const j = this.e.jogadores.get(sid);
    uid = uid | 0;
    if (uid && this.e.posse.get(String(uid)) === sid) { this.e.posse.delete(String(uid)); this.stats.liberados++; }
    if (j && (!uid || j.uid === uid)) j.uid = 0;
    return { ok: true };
  }

  // saída definitiva / fim da sessão / prazo de reconexão vencido: solta tudo dele
  soltarTudo(sid) {
    const del = [];
    this.e.skins.forEach((dono, skin) => { if (dono === sid) del.push(skin); });
    for (const s of del) this.e.skins.delete(s);
    const delU = [];
    this.e.posse.forEach((dono, uid) => { if (dono === sid) delU.push(uid); });
    for (const u of delU) this.e.posse.delete(u);
    const j = this.e.jogadores.get(sid); if (j) { j.skin = ''; j.uid = 0; }
    return { skins: del, unidades: delU };
  }

  // o servidor não aceita que um jogador "se declare" dono de um personagem: só repassa o que foi aprovado
  podeEnviar(sid, uid) { uid = uid | 0; if (!uid) return true; return this.e.posse.get(String(uid)) === sid; }
}

module.exports = { Personagens, CATALOGO, skinDaDescricao };
