import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DiarioCashKeeper } from '../cashkeeper-seguro.mjs';
import { herramientaManual } from '../cashkeeper-configuracion.mjs';
import { recuperarInterrupciones, validarRecuperacion } from '../cashkeeper-recuperacion.mjs';

class Maquina extends EventEmitter {
  constructor(p = null) { super(); this.interrumpida=p; this.credito=p && [2,7].includes(p.estado) ? p.valor : 0; this.ordenes=[]; this.props={}; this.intervalo=1; this.timeoutOperacion=2000; this.max='20,10'; this.min='3'; }
  asegurar() {} enTurno(fn) { return fn(); }
  async orden(c,p=[]) {
    this.antesDeEnviar?.(c); this.ordenes.push([c,...p]);
    if (this.corte && [29,42].includes(c)) throw new Error('Respuesta perdida después de enviar');
    if (c===40) return ['1']; if (c===38) return ['EUR','']; if (c===43) return [String(this.credito)]; if (c===44) return [String(this.salida ?? 0)];
    if (c===52) { this.credito=0; return []; } if (c===68) return [];
    if (c===79) return ['100,500','8,4','EUR']; if(c===19) return ['8,4']; if(c===17) return ['EUR','100','5'];
    if(c===63) return [String(this.props[p[0]] ?? 0)]; if(c===60) { this.props[p[0]]=p[1];return []; }
    if(c===23) return [this.max]; if(c===8) return [this.min]; if(c===35) {this.max=p[1];return [];} if(c===27) {this.min=p[1];return [];}
    if(c===24) return ['1000','200']; if(c===86) return ['2','100'];
    if(c===5) return ['1','0','2','1']; if(c===74) return ['identificador-modelo']; if(c===54) return ['1.2.3']; if(c===16) return ['2'];
    if([6,70,71,10].includes(c)) return [];
    if(c===42) {
      const actual=Math.max(this.interrumpida.valor,p[0]); this.salida=actual-p[0];
      this.emit('100',['0','',String(actual),String(p[0]),'2','0']); return [];
    }
    if(c===29) { const v=p[0]-(this.parcial ? 1 : 0); this.emit('100',[this.parcial?'32':'0','',String(v),String(p[0]),'3','0']);return []; }
    throw new Error(`Orden inesperada ${c}`);
  }
}
test('manual: leer propiedades, niveles y estado no mueve ni resetea efectivo',async()=>{
 const m=new Maquina();const r=await herramientaManual(m,{accion:'parametros'});
 assert.equal(r.estado_niveles.recaudacion_monedas,2);assert.equal(r.maximos[0].unidades,20);assert.equal(r.minimos[0].valor,500);
 assert.ok(m.ordenes.every(x=>[38,79,19,17,63,23,8,40,5].includes(x[0])));
});
test('manual: información no consulta secretos ni resetea quebranto',async()=>{
 const m=new Maquina();const r=await herramientaManual(m,{accion:'informacion'});assert.equal(r.quebranto,2);assert.deepEqual(r.contadores,{monedas:1000,billetes:200});assert.deepEqual(r.detalle_divisa,{decimales:2,multiplicador:100});assert.deepEqual(m.ordenes.find(x=>x[0]===16),[16,0]);assert.ok(!m.ordenes.some(x=>[82,83,56].includes(x[0])));
});
for(const h of [
 {accion:'guardar_propiedades',propiedades:[{id:3,valor:1}]},
 {accion:'guardar_propiedades',propiedades:[{id:82,valor:0}]},
 {accion:'guardar_propiedades',propiedades:[{id:13,valor:101}]},
 {accion:'guardar_niveles',nivel:'minimo',denominaciones:[{valor:100,unidades:2}]},
 {accion:'guardar_niveles',nivel:'maximo',denominaciones:[{valor:200,unidades:2}]},
 {accion:'pantalla',linea1:'$29|100#',linea2:'',grande:false},
]) test(`manual: rechaza ajuste no permitido ${JSON.stringify(h)}`,async()=>{const m=new Maquina();await assert.rejects(herramientaManual(m,{...h,confirmado:true}));assert.ok(!m.ordenes.some(x=>[60,35,27,10].includes(x[0])));});
test('manual: ajuste confirmado y releído; limpieza sin dinero',async()=>{
 const m=new Maquina();const r=await herramientaManual(m,{accion:'guardar_propiedades',confirmado:true,propiedades:[{id:18,valor:25}]});assert.equal(r.propiedades.find(x=>x.id===18).valor,25);
 await herramientaManual(m,{accion:'limpiar',confirmado:true,modo:'breve'});assert.deepEqual(m.ordenes.find(x=>x[0]===6),[6,1]);assert.ok(!m.ordenes.some(x=>[29,30,42,52].includes(x[0])));
});

function contexto(t,tipo,p,accion,extra={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-recuperar-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const diario=new DiarioCashKeeper(dir); const op={id:'incidencia',host:'mock',puerto:1,tipo,importe_centimos:tipo==='entrada'||tipo==='cambio'?0:500};
 diario.iniciar(op);diario.avance(op.id,{comando:p.estado===3?29:42,...extra});
 diario.terminar(op.id,{estado:'error',error:'Corte de conexión',resultado:{conciliar:true}});
 const maquina=new Maquina(p); const pedido={id:'decision-unica',accion,interrumpida:p}; const informes=[];
 const run=()=>recuperarInterrupciones(maquina,op,diario,async()=>pedido,async(id,d)=>{informes.push(d);return {resuelta:['cobrada','cancelada'].includes(d.estado)};});
 return {diario,maquina,pedido,informes,run,op};
}
test('recuperación de pago solo ordena el resto y nunca repite tras éxito',async t=>{
 const e=contexto(t,'salida',{estado:3,valor:200,objetivo:500,operacion:0},'continuar');await e.run();await e.run();
 assert.deepEqual(e.maquina.ordenes.filter(x=>x[0]===29),[[29,300,0]]);assert.equal(e.diario.leer('incidencia').final.progreso.devuelto,500);assert.equal(e.diario.leer('incidencia').recuperacion.anterior.error,'Corte de conexión');
});
test('recuperación cortada conserva bloqueo y no reenvía dinero',async t=>{
 const e=contexto(t,'salida',{estado:3,valor:200,objetivo:500,operacion:0},'continuar');e.maquina.corte=true;await e.run();await e.run();
 assert.equal(e.maquina.ordenes.filter(x=>x[0]===29).length,1);assert.equal(e.diario.leer('incidencia').final.resultado.conciliar,true);
});
test('recuperación parcial no marca éxito ni descarta el pendiente',async t=>{
 const e=contexto(t,'salida',{estado:3,valor:200,objetivo:500,operacion:0},'continuar');e.maquina.parcial=true;await e.run();assert.equal(e.diario.leer('incidencia').final.estado,'error');assert.ok(!e.maquina.ordenes.some(x=>[52,68].includes(x[0])));
});
test('cerrar salida parcial conserva solo importe realmente entregado',async t=>{
 const e=contexto(t,'salida',{estado:3,valor:200,objetivo:500,operacion:0},'cerrar_pago');await e.run();assert.equal(e.diario.leer('incidencia').final.progreso.devuelto,200);assert.ok(!e.maquina.ordenes.some(x=>[29,42].includes(x[0])));assert.equal(e.maquina.ordenes.filter(x=>x[0]===68).length,1);
});
for(const accion of ['devolver','continuar']) test(`recuperación de cobro: ${accion}`,async t=>{
 const e=contexto(t,'cobro',{estado:2,valor:200,objetivo:500,operacion:0},accion);await e.run();const f=e.diario.leer('incidencia').final;
 assert.equal(f.estado,accion==='devolver'?'cancelada':'cobrada');assert.equal(f.progreso.introducido-f.progreso.devuelto,accion==='devolver'?0:500);assert.equal(e.maquina.credito,0);
});
test('conservar recarga registra la cantidad introducida',async t=>{const e=contexto(t,'entrada',{estado:2,valor:200,objetivo:0,operacion:0},'conservar');await e.run();assert.equal(e.diario.leer('incidencia').final.progreso.objetivo,200);});
test('rechaza interrupción de otra operación, otra moneda o crédito incompatible',async t=>{
 const e=contexto(t,'cobro',{estado:2,valor:200,objetivo:500,operacion:0},'devolver');e.maquina.credito=201;await e.run();assert.ok(!e.maquina.ordenes.some(x=>[29,42,52].includes(x[0])));
 assert.throws(()=>validarRecuperacion({tipo:'devolucion',objetivo:500,comando:29},{id:'x',accion:'cerrar_pago',interrumpida:{estado:3,valor:200,objetivo:500,operacion:0}},{estado:3,valor:200,objetivo:500,operacion:0}));
});
test('resultado final durable se resincroniza tras pérdida del ACK sin pagar otra vez',async t=>{
 const e=contexto(t,'salida',{estado:3,valor:200,objetivo:500,operacion:0},'continuar');let falla=true;
 const callback=async(id,d)=>{if(d.estado==='cobrada'&&falla) throw new Error('Sin red');return {resuelta:d.estado==='cobrada'};};
 await recuperarInterrupciones(e.maquina,e.op,e.diario,async()=>e.pedido,callback);falla=false;
 await recuperarInterrupciones(e.maquina,e.op,e.diario,async()=>e.pedido,callback);assert.equal(e.maquina.ordenes.filter(x=>x[0]===29).length,1);assert.equal(e.diario.leer('incidencia').recuperacion.sincronizada,true);
});

for(const changed of [false,true]) test(`pago parcial con Disabled: ${changed?'rechaza última salida distinta':'recupera solo lo pendiente sin evento104'}`,async t=>{
 const e=contexto(t,'salida',{estado:3,valor:200,objetivo:500,operacion:0},'continuar');
 e.pedido.origen='terminal';e.maquina.interrumpida=null;e.maquina.salida=changed?201:200;
 e.diario.terminar('incidencia',{estado:'error',resultado:{conciliar:true,fin:{error:32,texto:'Sin cambio',actual:200,objetivo:500,estado:3,operacion:0}},progreso:{objetivo:500,introducido:0,devuelto:200}});
 await e.run();
 if(changed) { assert.equal(e.diario.leer('incidencia').final.estado,'error');assert.ok(!e.maquina.ordenes.some(x=>x[0]===29)); }
 else { assert.equal(e.diario.leer('incidencia').final.estado,'cobrada');assert.deepEqual(e.maquina.ordenes.filter(x=>x[0]===29),[[29,300,0]]); }
});

test('mensajes automáticos: excluye código protegido y delimitadores Raw',async()=>{
 const m=new Maquina();for(const h of [{codigo:1,texto:'TEXTO'},{codigo:24,texto:'TEXTO'},{codigo:17,texto:'$29#'}]) await assert.rejects(herramientaManual(m,{accion:'mensaje',confirmado:true,...h}));
 assert.ok(!m.ordenes.some(x=>x[0]===71));await herramientaManual(m,{accion:'mensaje',confirmado:true,codigo:17,texto:'TOTAL:'});assert.deepEqual(m.ordenes.find(x=>x[0]===71),[71,17,'TOTAL:']);
});

function cambioAceptado(t) {
 const p={estado:2,valor:50,objetivo:0,operacion:0};
 const e=contexto(t,'cambio',p,'devolver_cambio',{comando:52,fase:'cambio_aceptado',saldo:{introducido:50,devuelto:0}});
 e.pedido.origen='cambio_sin_pago';e.maquina.interrumpida=null;e.maquina.credito=0;
 e.diario.terminar(e.op.id,{estado:'error',error:'Value not supported. (orden79)',progreso:{fase:'metiendo',introducido:50,devuelto:0,objetivo:50},resultado:{conciliar:true,fin:{error:0,actual:50,objetivo:0,estado:2,operacion:0}}});
 return e;
}
test('cambio aceptado sin pago: devuelve solo50 una vez, con evidencia durable y sin asiento',async t=>{
 const e=cambioAceptado(t);await e.run();await e.run();
 assert.deepEqual(e.maquina.ordenes.filter(x=>x[0]===29),[[29,50,0]]);
 const final=e.diario.leer(e.op.id).final;assert.equal(final.estado,'cancelada');assert.equal(final.progreso.introducido,50);assert.equal(final.progreso.devuelto,50);assert.equal(final.resultado.recuperacion.origen,'cambio_sin_pago');
});
for(const caso of ['pago-enviado','saldo-distinto','devuelto','sin-diario','otro-fin','credito','interrumpida']) test(`cambio sin pago: bloquea evidencia incompatible ${caso}`,async t=>{
 const e=cambioAceptado(t);const local=e.diario.leer(e.op.id);
 if(caso==='pago-enviado')local.comando=29;
 if(caso==='saldo-distinto')local.saldo.introducido=100;
 if(caso==='devuelto')local.final.progreso.devuelto=1;
 if(caso==='sin-diario')delete local.fase;
 if(caso==='otro-fin')local.final.resultado.fin.estado=3;
 if(caso==='credito')e.maquina.credito=50;
 if(caso==='interrumpida')e.maquina.interrumpida=e.pedido.interrumpida;
 e.diario.guardar(e.op.id,local);await e.run();assert.ok(!e.maquina.ordenes.some(x=>[29,42,52,68].includes(x[0])));assert.equal(e.diario.leer(e.op.id).final.resultado.conciliar,true);
});
for(const caso of ['corte','parcial','ack-perdido']) test(`cambio sin pago no duplica después de ${caso}`,async t=>{
 const e=cambioAceptado(t);e.maquina.corte=caso==='corte';e.maquina.parcial=caso==='parcial';let perder=caso==='ack-perdido';
 const informar=async(id,d)=>{if(d.estado==='cancelada'&&perder){perder=false;throw new Error('Sin ACK');}return {resuelta:d.estado==='cancelada'};};
 for(let n=0;n<2;n++)await recuperarInterrupciones(e.maquina,e.op,e.diario,async()=>e.pedido,informar);
 assert.equal(e.maquina.ordenes.filter(x=>x[0]===29).length,1);assert.equal(e.diario.leer(e.op.id).final.resultado.conciliar,caso!=='ack-perdido');
});

function cobroAntiguo(t) {
 const p={estado:3,valor:180,objetivo:180,operacion:0};
 const e=contexto(t,'cobro',p,'confirmar_cobro',{comando:42});
 const x=e.diario.leer(e.op.id);x.objetivo=320;e.diario.guardar(e.op.id,x);
 e.pedido.origen='cobro_con_vuelta';e.pedido.introducido_confirmado=500;e.maquina.interrumpida=null;e.maquina.credito=0;e.maquina.salida=180;
 e.diario.terminar(e.op.id,{estado:'error',error:'El efectivo recibido y la devolución no cuadran',progreso:{fase:'devolviendo',introducido:180,devuelto:180,objetivo:320},resultado:{conciliar:true,fin:{error:0,texto:'',actual:180,objetivo:180,estado:3,operacion:0}}});
 return e;
}
test('confirmar cobro con vuelta no mueve dinero ni borra crédito; ACK perdido solo resincroniza',async t=>{
 const e=cobroAntiguo(t);let fallo=true;
 const informar=async(id,d)=>{if(d.estado==='cobrada'&&fallo){fallo=false;throw new Error('ACK perdido');}return {resuelta:d.estado==='cobrada'};};
 for(let n=0;n<2;n++)await recuperarInterrupciones(e.maquina,e.op,e.diario,async()=>e.pedido,informar);
 const x=e.diario.leer(e.op.id);assert.equal(x.final.estado,'cobrada');assert.equal(x.final.progreso.introducido,500);assert.equal(x.final.progreso.devuelto,180);assert.equal(x.recuperacion.sincronizada,true);
 assert.ok(e.maquina.ordenes.every(x=>[38,40,43,44].includes(x[0])));assert.equal(x.recuperacion.anterior.progreso.introducido,180);
});
for(const fallo of ['credito','salida','otra-orden','importe','interrupcion','sin-confirmacion'])test(`confirmar cobro antiguo bloquea ${fallo}`,async t=>{
 const e=cobroAntiguo(t);
 if(fallo==='credito')e.maquina.credito=1;
 if(fallo==='salida')e.maquina.salida=181;
 if(fallo==='otra-orden'){const x=e.diario.leer(e.op.id);x.comando=9;e.diario.guardar(e.op.id,x);}
 if(fallo==='importe')e.pedido.introducido_confirmado=600;
 if(fallo==='interrupcion')e.maquina.interrumpida=e.pedido.interrumpida;
 if(fallo==='sin-confirmacion')delete e.pedido.introducido_confirmado;
 await e.run();assert.equal(e.diario.leer(e.op.id).final.estado,'error');assert.ok(e.maquina.ordenes.every(x=>[38,40,43,44].includes(x[0])));
});
