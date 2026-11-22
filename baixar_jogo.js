// Baixa o HTML do jogo para publico/index.html no deploy (o arquivo e grande demais para o Git:
// o GitHub recusa acima de 100 MB). Defina URL_DO_JOGO nas variaveis de ambiente do Render,
// apontando para um anexo de Release do GitHub (ate 2 GB) ou qualquer URL publica.
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');
const url = process.env.URL_DO_JOGO;
const destino = path.join(__dirname, 'publico', 'index.html');
if (!url) { console.log('[OC] URL_DO_JOGO nao definida — nada a baixar.'); process.exit(0); }
fs.mkdirSync(path.dirname(destino), { recursive: true });
const baixar = (u, tentativa = 0) => {
  const lib = u.startsWith('https') ? https : http;
  lib.get(u, r => {
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && tentativa < 5) { r.resume(); return baixar(r.headers.location, tentativa + 1); }
    if (r.statusCode !== 200) { console.error('[OC] falhou: HTTP ' + r.statusCode); process.exit(1); }
    const f = fs.createWriteStream(destino + '.parcial');
    r.pipe(f);
    f.on('finish', () => { f.close(() => { fs.renameSync(destino + '.parcial', destino);
      console.log('[OC] jogo salvo: ' + (fs.statSync(destino).size / 1048576).toFixed(1) + ' MB'); }); });
  }).on('error', e => { console.error('[OC] erro: ' + e.message); process.exit(1); });
};
baixar(url);
