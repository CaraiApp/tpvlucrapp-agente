import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operarDirecto } from '../tpvlucrapp-agente.mjs';
import { operarCkfast } from '../cashkeeper-ckfast.mjs';
import { DiarioCashKeeper, niveles, inventario, recuperarCancelacionesVacias } from '../cashkeeper-seguro.mjs';

class Maquina extends EventEmitter {
  // El fsync del diario en el runner Windows puede superar40ms; solo la prueba de timeout usa ese límite.
  constructor(fallo = '') { super(); Object.assign(this, { fallo, estado: 1, credito: 0, metido: 0, salida: 0, ordenes: [], intervalo: 1, timeoutOperacion: fallo === 'sin-disabled' ? 40 : 2000, turno: Promise.resolve(), cambio: 10, recaudacion: 3, transferido: 0 }); }
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
    if (c === 29 || c === 30 || c === 87) {
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

function cambioVacio(e, { credito = 0, observado = 0, error = 0 } = {}) {
  const m = e.maquina, original = m.orden.bind(m);
  m.orden = async (c, p = []) => {
    if (c === 14) { m.antesDeEnviar?.(c); m.ordenes.push([c]); m.estado = 2; if (observado) m.emit('107', [String(observado),'0','0']); return []; }
    if (c === 9) { m.antesDeEnviar?.(c); m.ordenes.push([c,...p]); m.estado = 1; m.credito = credito; m.emit('100', [String(error),'','0','0','2','0']); return []; }
    return original(c,p);
  };
  m.salida = 5010; // ValueOUT conserva un pago anterior, no hay dinero en este cambio.
}
for (const tipo of ['cambio','entrada']) test(`${tipo}: cancelar vacío ignora ValueOUT anterior y no descarta ni paga`, async t => {
  const e = entorno(t); cambioVacio(e);
  const r = await ejecutar(op(tipo,{importe_centimos:0}),e,()=>({cancelar:true}));
  assert.equal(r.estado,'cancelada'); assert.equal(r.progreso.introducido,0); assert.equal(r.progreso.devuelto,0);
  assert.ok(!e.maquina.ordenes.some(x=>[29,30,44,52].includes(x[0])));
  assert.equal((await ejecutar(op('salida',{id:'siguiente'}),e)).estado,'cobrada');
});
for (const [nombre, opciones] of [['crédito',{credito:100}],['evento contradictorio',{observado:100}],['Disabled error',{error:32}]]) test(`cancelación vacía no oculta ${nombre}`, async t => {
  const e=entorno(t);cambioVacio(e,opciones);
  const r=await ejecutar(op('cambio',{importe_centimos:0}),e,()=>({cancelar:true}));
  assert.equal(r.estado,'error');assert.equal(r.resultado.conciliar,true);
  assert.ok(!e.maquina.ordenes.some(x=>[29,30,52].includes(x[0])));
});
test('devolución parcial al cancelar cambio sigue bloqueando, sin descartar crédito', async t => {
  const e=entorno(t), original=e.maquina.orden.bind(e.maquina);
  e.maquina.orden=async(c,p)=>{const r=await original(c,p);if(c===9)e.maquina.salida=200;return r;};
  const r=await ejecutar(op('cambio'),e,()=>({cancelar:true}));
  assert.equal(r.resultado.conciliar,true);assert.ok(!e.maquina.ordenes.some(x=>x[0]===52));
});
test('desconectar con incidencia conserva el error y permite reconectar sin permitir pagar', async t => {
  const e=entorno(t,'parcial');await ejecutar(op('salida'),e);e.maquina.credito=100;
  const antes=e.diario.leer('op-1'); const pausas=[]; e.maquina.guardarPausa=p=>pausas.push(p);
  const r=await ejecutar(op('mantenimiento',{id:'desconectar',herramienta:{accion:'desconectar',confirmado:true}}),e);
  assert.equal(r.resultado.cierre_confirmado,true);assert.deepEqual(e.diario.leer('op-1'),antes);assert.deepEqual(pausas,[true]);
  assert.ok(!e.maquina.ordenes.some(x=>x[0]===52));
  const c=await ejecutar(op('mantenimiento',{id:'conectar',herramienta:{accion:'conectar',confirmado:true}}),e);
  assert.equal(c.resultado.credito,100);assert.equal(c.resultado.conciliar,false);assert.equal(c.resultado.requiere_revision,true);assert.deepEqual(pausas,[true,false]);
  const pagos=e.maquina.ordenes.filter(x=>x[0]===29).length;
  await ejecutar(op('salida',{id:'otra'}),e);assert.equal(e.maquina.ordenes.filter(x=>x[0]===29).length,pagos);
});
test('desconectar sin comunicación pausa sin inventar un cierre confirmado', async t => {
  const e=entorno(t);e.maquina.orden=async()=>{throw new Error('Sin red');};let pausa;
  e.maquina.guardarPausa=p=>{pausa=p;};
  const r=await ejecutar(op('mantenimiento',{herramienta:{accion:'desconectar',confirmado:true}}),e);
  assert.equal(pausa,true);assert.equal(r.estado,'cobrada');assert.equal(r.resultado.cierre_confirmado,false);assert.equal(r.resultado.estado,undefined);
});
test('desconectar mientras la máquina recibe no cierra ni descarta', async t => {
  const e=entorno(t);e.maquina.estado=2;
  const r=await ejecutar(op('mantenimiento',{herramienta:{accion:'desconectar',confirmado:true}}),e);
  assert.equal(r.estado,'error');assert.ok(!e.maquina.ordenes.some(x=>[7,52].includes(x[0])));
});
function diarioVacio(e) {
  const o=op('cambio',{importe_centimos:0});e.diario.iniciar(o);e.diario.avance(o.id,{comando:9,enviado:true});
  e.diario.terminar(o.id,{estado:'error',error:'La cancelación no devolvió todo el crédito',resultado:{conciliar:true,fin:{error:0,texto:'',actual:0,objetivo:0,estado:2,operacion:0}},progreso:{fase:'esperando',objetivo:0,introducido:0,devuelto:0}});
  return o;
}
test('revisión humana de vacío se sincroniza tras reiniciar, conserva original y no mueve dinero', async t => {
  const e=entorno(t), o=diarioVacio(e), antes=e.diario.leer(o.id).final;
  const revision=async id=>({id,resolucion:'cancelacion_vacia',revisada_en:new Date().toISOString()});
  await assert.rejects(recuperarCancelacionesVacias(e.maquina,o,e.diario,revision,async()=>{throw new Error('sin red');}));
  assert.equal(e.diario.leer(o.id).final.estado,'cancelada');
  const nuevo=new DiarioCashKeeper(e.carpeta);let confirmaciones=0;
  await recuperarCancelacionesVacias(e.maquina,o,nuevo,revision,async()=>{confirmaciones++;return {resuelta:true};});
  assert.equal(confirmaciones,1);assert.deepEqual(nuevo.leer(o.id).revision.anterior,antes);assert.equal(nuevo.leer(o.id).revision.sincronizada,true);
  assert.equal(nuevo.pendientesVacios(o).length,0);assert.ok(e.maquina.ordenes.every(x=>[38,40,43].includes(x[0])));
});
for(const caso of ['sin-revision','otro-id','credito','parcial']) test(`recuperación vacía rechaza ${caso}`, async t=>{
  const e=entorno(t),o=diarioVacio(e);
  if(caso==='credito')e.maquina.credito=10;
  if(caso==='parcial'){const x=e.diario.leer(o.id);x.final.resultado.fin.actual=100;e.diario.guardar(o.id,x);}
  const antes=e.diario.leer(o.id);let confirmaciones=0;
  const f=()=>recuperarCancelacionesVacias(e.maquina,o,e.diario,async id=>({id:caso==='otro-id'?'otro':id,resolucion:caso==='sin-revision'?null:'cancelacion_vacia',revisada_en:'hoy'}),async()=>{confirmaciones++;return {resuelta:true};});
  if(caso==='credito')await assert.rejects(f());else await f();
  assert.deepEqual(e.diario.leer(o.id),antes);assert.equal(confirmaciones,0);
});

test('salida específica usa87, respeta unidades e importe y no sustituye denominaciones',async t=>{
 const e=entorno(t);const r=await ejecutar(op('salida',{seleccion:[{valor:100,unidades:5}]}),e);
 assert.equal(r.estado,'cobrada');assert.deepEqual(e.maquina.ordenes.find(x=>x[0]===87),[87,'100','5',0]);assert.ok(!e.maquina.ordenes.some(x=>[29,30].includes(x[0])));
});
for(const seleccion of [[{valor:100,unidades:4}],[{valor:200,unidades:3}]]) test('selección de salida inválida no mueve efectivo '+JSON.stringify(seleccion),async t=>{
 const e=entorno(t);const r=await ejecutar(op('salida',{seleccion}),e);assert.equal(r.estado,'error');assert.equal(r.resultado.conciliar,false);assert.ok(!e.maquina.ordenes.some(x=>[29,30,87].includes(x[0])));
});
test('desconectar tras un reinicio conserva el diario sin finalizar y no descarta dinero',async t=>{
 const e=entorno(t);e.diario.iniciar(op('salida'));const antes=e.diario.leer('op-1');
 const r=await ejecutar(op('mantenimiento',{id:'desconectar',herramienta:{accion:'desconectar',confirmado:true}}),e);assert.equal(r.estado,'cobrada');assert.deepEqual(e.diario.leer('op-1'),antes);assert.ok(!e.maquina.ordenes.some(x=>[29,52,68].includes(x[0])));
});

for(const listaAdmitida of [true,false]) test(`inventario sin orden79: descubre denominaciones ${listaAdmitida?'con78':'con lectura individual EUR'}`,async()=>{
 const ordenes=[];
 const m={orden:async(c,p=[])=>{ordenes.push([c,...p]);if(c===38)return ['EUR',''];if(c===79 || (c===78&&!listaAdmitida))throw Object.assign(new Error('No admitida'),{codigo:39});if(c===78)return ['100,200','500'];if(c===19){if(p[0]==='100')return ['3'];if(p[0]==='200')return ['0'];if(p[0]==='500')return ['2'];throw Object.assign(new Error('No admitida'),{codigo:39});}if(c===17)return ['EUR','200,5000','6,1'];throw new Error('No se permite dinero');}};
 const r=await inventario(m);assert.deepEqual(r.cambio,[{valor:100,unidades:3,divisa:'EUR'},{valor:200,unidades:0,divisa:'EUR'},{valor:500,unidades:2,divisa:'EUR'}]);assert.equal(r.recaudacion[0].unidades,6);
 assert.ok(ordenes.every(x=>[38,79,78,19,17].includes(x[0])));
});
for(const fallo of ['red','datos','otra-divisa']) test(`inventario incompatible no inventa efectivo: ${fallo}`,async()=>{
 const ordenes=[];const m={orden:async(c)=>{ordenes.push(c);if(c===38)return [fallo==='otra-divisa'?'GBP':'EUR'];if(c===79){if(fallo==='red')throw new Error('Sin red');if(fallo==='datos')return ['100,200','5','EUR'];}throw Object.assign(new Error('No admitida'),{codigo:39});}};
 await assert.rejects(inventario(m));assert.ok(!ordenes.includes(19));
});
test('salida específica sin existencias con orden79 no admitida: no paga ni crea conciliación',async t=>{
 const e=entorno(t);const original=e.maquina.orden.bind(e.maquina);
 e.maquina.orden=async(c,p=[])=>{if(c===79)throw Object.assign(new Error('No admitida'),{codigo:39});return original(c,p);};
 const r=await ejecutar(op('salida',{importe_centimos:200,seleccion:[{valor:200,unidades:1}]}),e);
 assert.equal(r.estado,'error');assert.equal(r.resultado.conciliar,false);assert.ok(!e.maquina.ordenes.some(x=>[29,30,87].includes(x[0])));
});

test('Dar cambio no admite dinero si falla la consulta previa de inventario',async t=>{
 const e=entorno(t);const original=e.maquina.orden.bind(e.maquina);
 e.maquina.orden=async(c,p=[])=>{if(c===79)throw new Error('Sin respuesta de inventario');return original(c,p);};
 const r=await ejecutar(op('cambio',{importe_centimos:0}),e,()=>({terminar:true}));
 assert.equal(r.estado,'error');assert.equal(r.resultado.conciliar,false);assert.ok(!e.maquina.ordenes.some(x=>[14,9,29,30,52].includes(x[0])));
});
test('error40 explícito permite descubrir valores y leer individualmente, sin ocultar datos corruptos',async()=>{
 const ordenes=[];const m={orden:async(c,p=[])=>{ordenes.push(c);if(c===38)return ['EUR'];if([79,78].includes(c)||c===19&&p[0].includes(','))throw Object.assign(new Error('Not supported values'),{codigo:40});if(c===19){if(p[0]==='100')return ['2'];throw Object.assign(new Error('No admitido'),{codigo:39});}if(c===17)return ['EUR','',''];throw new Error('Orden física inesperada');}};
 assert.deepEqual((await inventario(m)).cambio,[{valor:100,unidades:2,divisa:'EUR'}]);assert.ok(ordenes.every(c=>[38,79,78,19,17].includes(c)));
});
