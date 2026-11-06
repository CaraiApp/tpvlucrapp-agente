// La actualización automática (Luis, 5-11): solo de madrugada, con una versión más nueva, con el cajón libre y sin repetir
// el mismo intento; la descarga se comprueba arrancándola con --version antes de instalar nada. Sin GitHub: un servidor local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { esMasNueva, tocaActualizar, descargar, comprobarVersion, actualizar, limpiarDescargas, guardarIntento, leerIntento } from '../actualizacion.mjs';

const a = (h, m = 0) => { const d = new Date(2026, 10, 6, h, m); return d; };

test('solo una versión publicada más nueva, de madrugada, con el cajón libre y sin haberlo intentado hoy', () => {
  assert.equal(esMasNueva('0.8.13', '0.8.12'), true);
  assert.equal(esMasNueva('0.8.12', '0.8.12'), false);
  assert.equal(esMasNueva('0.10.0', '0.9.9'), true);
  assert.equal(esMasNueva('x', '0.8.12'), false);
  const base = { actual: '0.8.12', publicada: '0.8.13', ahora: a(5) };
  assert.equal(tocaActualizar(base), true);
  assert.equal(tocaActualizar({ ...base, publicada: '0.8.12' }), false);
  assert.equal(tocaActualizar({ ...base, publicada: '0.8.11' }), false);
  assert.equal(tocaActualizar({ ...base, ahora: a(14) }), false, 'en pleno servicio, nunca');
  assert.equal(tocaActualizar({ ...base, ahora: a(3, 59) }), false);
  assert.equal(tocaActualizar({ ...base, ahora: a(7) }), false);
  assert.equal(tocaActualizar({ ...base, cajonEnMarcha: true }), false, 'con un cobro en marcha, nunca');
  assert.equal(tocaActualizar({ ...base, ultimoIntento: { version: '0.8.13', en: a(4, 30).toISOString() } }), false, 'ya intentado hoy');
  assert.equal(tocaActualizar({ ...base, ultimoIntento: { version: '0.8.12', en: a(4, 30).toISOString() } }), true, 'otra versión, sí');
  assert.equal(tocaActualizar({ ...base, ultimoIntento: { version: '0.8.13', en: new Date(2026, 10, 5, 4).toISOString() } }), true, 'ayer, sí');
});

test('descarga a un archivo y comprueba que el programa descargado dice la versión esperada', async t => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-actualizar-'));
  t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
  const srv = http.createServer((req, res) => { if (req.url === '/v0.8.13/x.exe') { res.writeHead(200); res.end('PROGRAMA NUEVO'); } else { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const destino = path.join(carpeta, 'tpvlucrapp-agente-0.8.13.exe');
  assert.equal(await descargar(`${base}/v0.8.13/x.exe`, destino), 14);
  assert.equal(fs.readFileSync(destino, 'utf8'), 'PROGRAMA NUEVO');
  assert.ok(!fs.readdirSync(carpeta).some(f => f.endsWith('.parte')));
  await assert.rejects(descargar(`${base}/v0.9.0/x.exe`, path.join(carpeta, 'otra.exe')), /404/);
  // El ejecutable de mentira: dice su versión por la salida.
  const ejecutar = version => () => { const h = new EventEmitter(); h.stdout = new EventEmitter(); h.kill = () => {}; setTimeout(() => { h.stdout.emit('data', `${version}\n`); h.emit('exit', 0); }, 5); return h; };
  await comprobarVersion(destino, '0.8.13', { ejecutar: ejecutar('0.8.13') });
  await assert.rejects(comprobarVersion(destino, '0.8.13', { ejecutar: ejecutar('0.8.12') }), /se esperaba la 0\.8\.13/);
  // Todo junto: descarga, comprueba y lanza el instalador con el archivo descargado; si la versión no es la suya, no lanza nada.
  const lanzados = [];
  const hecho = await actualizar({ version: '0.8.13', url: `${base}/v0.8.13/x.exe`, carpeta, ejecutar: ejecutar('0.8.13'), lanzar: async d => { lanzados.push(d); } });
  assert.deepEqual(lanzados, [hecho]);
  await assert.rejects(actualizar({ version: '0.8.13', url: `${base}/v0.8.13/x.exe`, carpeta, ejecutar: ejecutar('0.0.1'), lanzar: async d => { lanzados.push(d); } }));
  assert.equal(lanzados.length, 1);
});

test('al arrancar se limpian las descargas de otras versiones y el último intento se recuerda', t => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-descargas-'));
  t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
  for (const f of ['tpvlucrapp-agente-0.8.12.exe', 'tpvlucrapp-agente-0.8.13.exe', 'ultimo-intento.json']) fs.writeFileSync(path.join(carpeta, f), 'x');
  limpiarDescargas(carpeta, '0.8.13');
  assert.deepEqual(fs.readdirSync(carpeta).sort(), ['tpvlucrapp-agente-0.8.13.exe', 'ultimo-intento.json']);
  const marca = path.join(carpeta, 'ultimo-intento.json');
  guardarIntento(marca, '0.8.14', 'lanzada');
  assert.equal(leerIntento(marca).version, '0.8.14');
  assert.equal(leerIntento(path.join(carpeta, 'no-existe.json')), null);
});
