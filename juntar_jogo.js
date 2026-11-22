// Junta as partes do jogo (jogo/parte_00, parte_01, ...) em publico/index.html no build do Render.
// O HTML tem ~127 MB e o GitHub recusa arquivos acima de 100 MB, por isso ele fica dividido no repositório.
// Se URL_DO_JOGO estiver definida, o baixar_jogo.js é usado no lugar disto.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const pasta = path.join(__dirname, 'jogo');
const destino = path.join(__dirname, 'publico', 'index.html');
const partes = fs.readdirSync(pasta).filter(f => /^parte_\d+$/.test(f)).sort();
if (!partes.length) { console.error('[OC] nenhuma parte do jogo em jogo/'); process.exit(1); }
fs.mkdirSync(path.dirname(destino), { recursive: true });
const hash = crypto.createHash('sha256'), fd = fs.openSync(destino, 'w');
for (const p of partes) { const b = fs.readFileSync(path.join(pasta, p)); hash.update(b); fs.writeSync(fd, b); }
fs.closeSync(fd);
const obtido = hash.digest('hex');
let esperado = ''; try { esperado = fs.readFileSync(path.join(pasta, 'SHA256.txt'), 'utf8').trim(); } catch (e) {}
if (esperado && esperado !== obtido) { console.error('[OC] SHA-256 não confere: ' + obtido); process.exit(1); }
console.log('[OC] jogo montado: ' + partes.length + ' partes, ' + (fs.statSync(destino).size / 1048576).toFixed(1) + ' MB, SHA-256 ok');
