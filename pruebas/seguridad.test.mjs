import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operarDirecto } from '../tpvlucrapp-agente.mjs';
import { operarCkfast } from '../cashkeeper-ckfast.mjs';
import { DiarioCashKeeper, niveles, inventario } from '../cashkeeper-seguro.mjs';

class Maquina extends EventEmitter {
  constructor(fallo = '') { super(); Object.assign(this, { fallo, estado: 1, credito: 0, metido: 0, salida: 0, ordenes: [], intervalo: 1, timeoutOperacion: 40, turno: Promise.resolve(), cambio: 10, recaudacion: 3, transferido: 0 }); }
  asegurar() { if (this.pausada && this.estado === 0) throw new Error("Desconectada"); if (this.estado === 0) this.estado = 1; if (this.fallo === 'antes') throw new Error('Timeout antes de enviar'); }
  mantenerViva() {}
  soltar() {}
  enTurno(fn) { const p = this.turno.then(fn); this.turno = p.catch(() => {}); return p; }
  fin(valor, objetivo, estado = 2) {
    this.estado = 1;
    if (this.fallo === 'sin-disabled') { this.emit('106', ['1']); return; }
    const p = [this.fallo === 'parcial' && estado === 3 ? '32' : '0', '', String(valor), String(objetivo), String(estado), '0'];
    this.emit('100', p);
    if (this.fallo === 'duplicada') this.emit('100', p);
  }
  async orden(c, p = []) {
    this.antesDeEnviar?.(c); this.ordenes.push([c, ...p]);
    if ([42, 29, 30, 12, 13].includes(c) && ['despues', 'corte'].includes(this.fallo)) {
      this.salida = 100;
      if (this.fallo === 'corte') this.emit('cortada');
      throw new Error('Respuesta perdida después del envío');
    }
    if (c === 38) return ['EUR', ''];
    if (c === 78) return ['100',''];
    if (c === 19) return [String(this.cambio)];
    if (c === 40) return [String(this.estado)];
    if (c === 43) return [String(this.credito)];
    if (c === 44) return [String(this.salida)];
    if (c === 45) return [String(this.transferido)];
    if (c === 67) return [];
    if (c === 52) { this.credito = 0; return []; }
    if (c === 7) { this.estado = 0; return []; }
    if (c === 79) return ['100', String(this.cambio), 'EUR'];
    if (c === 17) return ['EUR', '100', String(this.recaudacion)];
    if (c === 21) return [p[1].split(',').map(() => '0').join(',')];
    if (c === 36) return [];
    if (c === 11) { this.recaudacion = 0; return []; }
    if (c === 12 || c === 13) { const conservar = c === 12 ? 0 : Number(p[1]); const n = Math.max(0, this.cambio - conservar); this.cambio -= n; this.recaudacion += n; this.transferido = n * 100; this.fin(this.transferido, this.transferido, c === 12 ? 5 : 4); return []; }
    if (c === 14) { this.estado = 2; this.metido = this.credito = 500; this.emit('107', ['500', '0', '0']); return []; }
    if (c === 9) { this.salida = p[0] === 1 ? this.metido : 0; this.fin(this.metido, 0); return []; }
    if (c === 42) { this.metido = this.credito = Number(p[0]) + 100; this.salida = 100; this.emit('107', [String(this.metido), String(p[0]), '0']); this.fin(this.metido, Number(p[0])); return []; }
    if (c === 29 || c === 30) {
      if (this.fallo === 'rechazo') throw Object.assign(new Error('No hay cambio'), { codigo: 32, rechazoSeguro: true });
      const pedido = c === 29 ? Number(p[0]) : p[0].split(',').reduce((s, v, i) => s + Number(v) * Number(p[1].split(',')[i]), 0);
      this.salida = this.fallo === 'parcial' ? pedido - 100 : pedido;
      this.emit('108', [String(this.salida), String(pedido), '0']); this.fin(this.salida, pedido, 3); return [];
    }
    throw new Error(`Comando no simulado: ${c}`);
  }
}
const op = (tipo = 'cobro', extra = {}) => ({ id: 'op-1', host: 'mock', puerto: 1, tipo, importe_centimos: 500, propina_centimos: 0, ...extra });
function entorno(t, fallo) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-seguridad-'));
  t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
  return { diario: new DiarioCashKeeper(carpeta), maquina: new Maquina(fallo), carpeta };
}
async function ejecutar(op, e, pedidos = () => ({})) {
  const mensajes = [];
  await operarDirecto(op, async (estado, error, resultado, progreso) => { mensajes.push({ estado, error, resultado, progreso }); return pedidos(progreso); }, e);
  return mensajes.at(-1);
}
for (const tipo of ['cobro', 'salida', 'devolucion']) test(`${tipo}: confirma importe real y persiste Disabled`, async t => {
  const e = entorno(t); const f = await ejecutar(op(tipo), e);
  assert.equal(f.estado, 'cobrada'); assert.equal(e.diario.leer('op-1').final.resultado.fin.error, 0);
  if (tipo === 'cobro') assert.equal(e.maquina.credito, 0); else assert.equal(f.progreso.devuelto, 500);
});
for (const fallo of ['despues', 'corte', 'sin-disabled', 'parcial']) test(`${fallo}: bloquea nuevos pagos y no repite`, async t => {
  const e = entorno(t, fallo); const f = await ejecutar(op('salida'), e);
  assert.equal(f.estado, 'error'); assert.equal(f.resultado.conciliar, true);
  const n = e.maquina.ordenes.filter(x => x[0] === 29).length;
  await ejecutar(op('salida', { id: 'op-2' }), e);
  assert.equal(e.maquina.ordenes.filter(x => x[0] === 29).length, n);
});
test('timeout antes del envío no mueve efectivo', async t => { const e = entorno(t, 'antes'); const f = await ejecutar(op(), e); assert.equal(f.estado, 'error'); assert.equal(f.resultado.conciliar, false); assert.equal(e.maquina.ordenes.length, 0); });
test('rechazo explícito Pay no inventa dinero pagado', async t => { const e = entorno(t, 'rechazo'); const f = await ejecutar(op('salida'), e); assert.equal(f.estado, 'error'); assert.equal(f.resultado.conciliar, false); assert.equal(e.maquina.salida, 0); });
test('doble solicitud y respuesta duplicada: solo un pago físico', async t => { const e = entorno(t, 'duplicada'); const r = await Promise.all([ejecutar(op('salida'), e), ejecutar(op('salida'), e)]); assert.ok(r.every(x => x.estado === 'cobrada')); assert.equal(e.maquina.ordenes.filter(x => x[0] === 29).length, 1); });
test('reinicio durante operación: no manda otra orden', async t => { const e = entorno(t); e.diario.iniciar(op()); const nuevo = { ...e, diario: new DiarioCashKeeper(e.carpeta) }; const r = await ejecutar(op(), nuevo); assert.equal(r.resultado.conciliar, true); assert.equal(e.maquina.ordenes.length, 0); });
test('reinicio tras éxito repite el resultado, nunca el dinero', async t => { const e = entorno(t); await ejecutar(op('salida'), e); const m = new Maquina(); const r = await ejecutar(op('salida'), { diario: new DiarioCashKeeper(e.carpeta), maquina: m }); assert.equal(r.estado, 'cobrada'); assert.equal(m.ordenes.length, 0); });
test('crédito previo bloquea cobro y no descarta fondos', async t => { const e = entorno(t); e.maquina.credito = 200; const r = await ejecutar(op(), e); assert.equal(r.resultado.conciliar, true); assert.ok(!e.maquina.ordenes.some(x => [42, 52].includes(x[0]))); });
test('recarga: ActivateRefillMode, Enable, Disable, Disabled y Discard; registra lo recibido', async t => { const e = entorno(t); const r = await ejecutar(op('entrada', { importe_centimos: 0 }), e, () => ({ terminar: true })); assert.equal(r.estado, 'cobrada'); assert.equal(r.progreso.introducido, 500); assert.equal(e.maquina.credito, 0); assert.deepEqual(e.maquina.ordenes.filter(x => [67, 14, 9, 52].includes(x[0])).map(x => x[0]), [67, 14, 9, 52]); });
test('cancelación comprueba lo devuelto antes de limpiar crédito', async t => { const e = entorno(t); const r = await ejecutar(op('entrada', { importe_centimos: 0 }), e, () => ({ cancelar: true })); assert.equal(r.estado, 'cancelada'); assert.equal(r.progreso.devuelto, 500); });
for (const accion of ['cierre', 'recicladores']) test(`${accion}: traslado interno cuadra con niveles`, async t => { const e = entorno(t); const r = await ejecutar(op('mantenimiento', { herramienta: { accion, confirmado: true, conservar: [{ valor: 100, unidades: 4 }], dispositivo: 'todo' } }), e); assert.equal(r.estado, 'cobrada'); assert.equal(r.resultado.movimiento_interno, true); assert.equal(e.maquina.cambio, accion === 'cierre' ? 4 : 0); });
test('retirada exige confirmación humana y solo resetea contador', async t => { const e = entorno(t); const r = await ejecutar(op('vaciado', { vaciar: 'monedas' }), e, () => ({ terminar: true })); assert.equal(r.estado, 'cobrada'); assert.equal(r.progreso.devuelto, 300); assert.equal(e.maquina.cambio, 10); assert.equal(e.maquina.recaudacion, 0); });
test('retirada sin confirmar conserva bloqueo, no inventa cancelación física', async t => { const e = entorno(t); const r = await ejecutar(op('vaciado', { vaciar: 'monedas' }), e, () => ({ cancelar: true })); assert.equal(r.resultado.conciliar, true); assert.equal(e.maquina.recaudacion, 3); });
test('Dar cambio conserva importe y no crea movimiento contable', async t => { const e = entorno(t); const r = await ejecutar(op('cambio'), e, p => p?.fase === 'eligiendo' ? { seleccion: [{ valor: 100, unidades: 5 }] } : { terminar: true }); assert.equal(r.estado, 'cobrada'); assert.equal(r.progreso.introducido, r.progreso.devuelto); });
test('Dar cambio parcial se detiene sin pagar el resto a ciegas', async t => { const e = entorno(t, 'parcial'); const r = await ejecutar(op('cambio'), e, p => p?.fase === 'eligiendo' ? { seleccion: [{ valor: 100, unidades: 5 }] } : { terminar: true }); assert.equal(r.resultado.conciliar, true); assert.equal(e.maquina.ordenes.filter(x => x[0] === 30).length, 1); assert.equal(r.progreso.devuelto, 400); assert.equal(r.resultado.fin.actual, 400); });
test('niveles preservan divisas y rechazan datos malformados', () => { assert.equal(niveles('100,100', '3,2', 'EUR,USD')[1].divisa, 'USD'); assert.throws(() => niveles('1,2', '3', 'EUR')); assert.throws(() => niveles('1', 'NaN', 'EUR')); });
test('niveles actuales aíslan un valor sin reciclador sin usar niveles antiguos ni mover dinero', async () => {
  const ordenes = [];
  const m = { async orden(c, p = []) {
    ordenes.push([c, ...p]);
    if (c === 38) return ['EUR'];
    if (c === 79) return ['100,50000,100', '9,0,2', 'EUR,EUR,USD'];
    if (c === 19 && p[0] === '100') return ['7'];
    if (c === 19) throw Object.assign(new Error('Value not supported'), { codigo: 39 });
    if (c === 17) return ['EUR', '100', '3'];
    throw new Error('No se permite mover efectivo');
  } };
  const r = await inventario(m);
  assert.deepEqual(r.cambio, [{valor:100,unidades:2,divisa:'USD'}, {valor:100,unidades:7,divisa:'EUR'}]);
  assert.deepEqual(ordenes, [[38],[79,0],[19,'100,50000'],[19,'100'],[19,'50000'],[17]]);
});
for (const caso of ['nivel-no-cero', 'error-distinto', 'ninguna-admitida']) test(`consulta no oculta inventario incompleto: ${caso}`, async () => {
  const m = { async orden(c) {
    if (c === 38) return ['EUR'];
    if (c === 79) return ['50000', caso === 'nivel-no-cero' ? '1' : '0', 'EUR'];
    if (c === 19) throw Object.assign(new Error('Consulta rechazada'), { codigo: caso === 'error-distinto' ? 37 : 39 });
    throw new Error('No debe continuar con recaudación');
  } };
  await assert.rejects(inventario(m), caso === 'ninguna-admitida' ? /ninguna denominación/ : /Consulta rechazada/);
});
test('fallo de lectura no crea un diario incierto ni envía pagos', async t => {
  const e = entorno(t);
  const original = e.maquina.orden.bind(e.maquina);
  e.maquina.orden = async (c, p) => { if (c === 19) throw Object.assign(new Error('Value not supported'), {codigo:39}); return original(c,p); };
  const r = await ejecutar(op('mantenimiento', {herramienta:{accion:'niveles'}}), e);
  assert.equal(r.estado, 'error'); assert.equal(e.diario.leer('op-1'), null);
  assert.ok(!e.maquina.ordenes.some(x => [9,11,12,13,14,29,30,42,52,67].includes(x[0])));
});
test('CKFast: respuesta C perdida, consulta mismo ticket y persiste el éxito', async t => { const e = entorno(t); const cmds = []; let final; await operarCkfast(op('cobro', { ticket: '1', orden: 'C|1|500' }), async (...x) => { final = x; }, { diario: e.diario, intervalo: 1, timeout: 10, orden: async x => { cmds.push(x); if (x[0] === 'C') throw new Error('corte'); return 'OK|OK'; } }); assert.deepEqual(cmds, ['C|1|500', 'S|1']); assert.equal(final[0], 'cobrada'); });
test('CKFast: reinicio consulta S sin repetir C ni cambiar de método', async t => { const e = entorno(t); const o = op('cobro', { ticket: '1', orden: 'C|1|500' }); e.diario.iniciar(o); const cmds = []; let final; await operarCkfast({ ...o, reanudar: true }, async (...x) => { final = x; }, { diario: e.diario, intervalo: 1, timeout: 5, orden: async x => { cmds.push(x); return 'NOK|Not found'; } }); assert.deepEqual(cmds, ['S|1']); assert.equal(final[2].conciliar, true); });

test('misma identidad con otro importe no repite ni devuelve un éxito ajeno', async t => { const e = entorno(t); await ejecutar(op('salida'), e); const r = await ejecutar(op('salida', { importe_centimos: 900 }), e); assert.equal(r.estado, 'error'); assert.equal(r.resultado.conciliar, true); assert.equal(e.maquina.ordenes.filter(x => x[0] === 29).length, 1); });

test('backend sin red al confirmar no convierte un pago confirmado en error', async t => {
  const e = entorno(t); let perdidos = 0;
  await operarDirecto(op('salida'), async estado => { if (estado === 'cobrada' && perdidos++ === 0) throw new Error('backend sin red'); }, e);
  assert.equal(e.diario.leer('op-1').final.estado, 'cobrada');
  assert.equal(e.maquina.ordenes.filter(x => x[0] === 29).length, 1);
});

test('inhibiciones lee las denominaciones reconocidas antes de consultar su estado', async t => { const e = entorno(t); const r = await ejecutar(op('mantenimiento', { herramienta: {accion:'inhibiciones'} }),e); assert.equal(r.estado,'cobrada'); assert.deepEqual(r.resultado.denominaciones,[{valor:100,estado:0}]); assert.deepEqual(e.maquina.ordenes.map(x=>x[0]),[78,21]); });
test('configuración comprueba la lectura posterior y rechaza aceptar sin pagar billetes', async t => { const e = entorno(t); const r = await ejecutar(op('mantenimiento',{herramienta:{accion:'configurar',confirmado:true,denominaciones:[{valor:100,estado:0}]}}),e); assert.equal(r.estado,'cobrada'); const r2=await ejecutar(op('mantenimiento',{id:'invalid',herramienta:{accion:'configurar',confirmado:true,denominaciones:[{valor:500,estado:1}]}}),e); assert.equal(r2.estado,'error'); assert.equal(e.maquina.ordenes.filter(x=>x[0]===36).length,1); });
test('desconexión confirma cerrado y conexión vuelve a reposo', async t => { const e = entorno(t); const a = await ejecutar(op('mantenimiento',{herramienta:{accion:'desconectar',confirmado:true}}),e); assert.equal(a.resultado.estado,0); const b=await ejecutar(op('mantenimiento',{id:'reconectar',herramienta:{accion:'conectar',confirmado:true}}),e); assert.equal(b.resultado.estado,1); });
