// «Rearmar» desde la caja (Luis, 5-11): el encargado decide con la máquina delante y el programa solo cierra su diario, que
// es lo que bloqueaba los cobros nuevos. Sin TCP: una máquina de juguete que contesta en reposo y sin crédito.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DiarioCashKeeper, recuperarRearmes } from '../cashkeeper-seguro.mjs';

const op = (id, extra = {}) => ({ id, tipo: 'cobro', importe_centimos: 280, propina_centimos: 0, host: '127.0.0.1', puerto: 8001, ...extra });

function maquina({ estado = '1', credito = '0' } = {}) {
  const m = new EventEmitter();
  m.ordenes = [];
  m.asegurar = async () => {};
  m.enTurno = fn => fn();
  m.orden = async (c) => { m.ordenes.push(c); if (c === 40) return [estado]; if (c === 43) return [credito]; if (c === 38) return ['EUR']; return ['OK']; };
  return m;
}

function diarioCon(t, finales) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rearme-'));
  t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
  const diario = new DiarioCashKeeper(carpeta);
  // La primera entra como de verdad; las demás se escriben directas (la primera ya bloquearía `iniciar`).
  let base = null;
  for (const [id, final] of Object.entries(finales)) {
    if (!base) { diario.iniciar(op(id)); base = diario.leer(id); } else diario.guardar(id, { ...base, id, huella: `h-${id}` });
    if (final) diario.terminar(id, final);
  }
  return diario;
}

const incidencia = { estado: 'error', error: 'El final no corresponde a la entrada de efectivo', progreso: { fase: 'metiendo', objetivo: 280, introducido: 2000, devuelto: 720 }, resultado: { conciliar: true, fin: { error: 0, texto: '', actual: 0, objetivo: 0, estado: 1, operacion: 0 } } };

test('una incidencia bloquea el diario; rearmada como «se cobró», queda cobrada sin conciliar y deja de bloquear', async t => {
  const diario = diarioCon(t, { 'op-1': incidencia });
  assert.throws(() => diario.iniciar(op('op-2')), /pendiente de conciliación/);
  const m = maquina(); const confirmadas = [];
  await recuperarRearmes(m, op('op-1'), diario, async id => ({ id, resolucion: 'rearme', decision: 'apuntar', revisada_en: '2026-11-05T22:00:00.000Z' }),
    async (id, datos) => { confirmadas.push([id, datos]); return { resuelta: true }; });
  const guardada = diario.leer('op-1');
  assert.equal(guardada.final.estado, 'cobrada');
  assert.equal(guardada.final.resultado.conciliar, false);
  assert.equal(guardada.final.error, undefined);
  assert.equal(guardada.final.progreso.fase, 'hecho');
  assert.equal(guardada.revision.resolucion, 'rearme');
  assert.equal(guardada.revision.sincronizada, true);
  assert.deepEqual(confirmadas, [['op-1', { estado: 1, credito: 0, interrumpida: false }]]);
  // Se comprobó la máquina antes (reposo, crédito, divisa) y nunca se le mandó una orden de dinero.
  assert.ok(m.ordenes.includes(40) && m.ordenes.includes(43));
  assert.ok(!m.ordenes.some(c => [9, 29, 30, 42, 52, 87].includes(c)));
  assert.equal(diario.iniciar(op('op-2')), null);
});

test('«no se movió nada» deja la operación cancelada; una sin final (el programa se cayó a medias) también se rearma', async t => {
  const diario = diarioCon(t, { 'op-1': incidencia, 'op-3': null });
  await recuperarRearmes(maquina(), op('op-1'), diario, async id => ({ id, resolucion: 'rearme', decision: 'nada', revisada_en: '2026-11-05T22:00:00.000Z' }), async () => ({ resuelta: true }));
  assert.equal(diario.leer('op-1').final.estado, 'cancelada');
  assert.equal(diario.leer('op-3').final.estado, 'cancelada');
  assert.equal(diario.leer('op-3').final.resultado.conciliar, false);
  assert.equal(diario.leer('op-3').final.progreso.objetivo, 280);
  assert.equal(diario.iniciar(op('op-4')), null);
});

test('con la máquina ocupada o con crédito no se toca el diario; y lo que la plataforma no ha rearmado, tampoco', async t => {
  const diario = diarioCon(t, { 'op-1': incidencia });
  await assert.rejects(recuperarRearmes(maquina({ estado: '2' }), op('op-1'), diario, async id => ({ id, resolucion: 'rearme', decision: 'apuntar', revisada_en: 'x' }), async () => ({ resuelta: true })), /crédito|interrumpida|reposo|Requiere conciliación/);
  assert.equal(diario.leer('op-1').final.resultado.conciliar, true);
  await assert.rejects(recuperarRearmes(maquina({ credito: '500' }), op('op-1'), diario, async id => ({ id, resolucion: 'rearme', decision: 'apuntar', revisada_en: 'x' }), async () => ({ resuelta: true })));
  assert.equal(diario.leer('op-1').final.resultado.conciliar, true);
  const confirmadas = [];
  await recuperarRearmes(maquina(), op('op-1'), diario, async id => ({ id, resolucion: null }), async (...a) => { confirmadas.push(a); return { resuelta: true }; });
  assert.equal(diario.leer('op-1').final.resultado.conciliar, true);
  assert.equal(confirmadas.length, 0);
  assert.throws(() => diario.iniciar(op('op-2')), /pendiente de conciliación/);
});

test('sin conexión directa (CKMonitor) se cierra el diario sin preguntar a ninguna máquina, y lo de las máquinas directas se deja aparte', async t => {
  const diario = diarioCon(t, { 'op-1': incidencia });
  diario.iniciar(op('op-ck', { host: 'pc-barra', puerto: 16501 })); diario.terminar('op-ck', { ...incidencia, resultado: { protocolo: 'ckfast', ticket: '1', conciliar: true } });
  const vistas = [];
  await recuperarRearmes(null, null, diario, async id => { vistas.push(id); return { id, resolucion: 'rearme', decision: 'nada', revisada_en: 'x' }; }, async () => ({ resuelta: true }), [{ host: '127.0.0.1', puerto: 8001 }]);
  assert.deepEqual(vistas, ['op-ck']);
  assert.equal(diario.leer('op-ck').final.estado, 'cancelada');
  assert.equal(diario.leer('op-1').final.resultado.conciliar, true);
});
