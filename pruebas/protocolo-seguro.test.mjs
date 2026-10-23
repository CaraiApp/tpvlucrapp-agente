// Transporte TCP real local; servidor sintético, sin hardware ni credenciales del local.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MaquinaDirecta, operarDirecto, leerEfectivo } from '../tpvlucrapp-agente.mjs';
import { DiarioCashKeeper } from '../cashkeeper-seguro.mjs';
async function escenario(t, fallo = '') {
  const ordenes = []; const sockets = new Set();
  const server = net.createServer(s => {
    sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s));
    let buffer = ''; const enviar = msg => s.write(msg);
    s.on('data', trozo => {
      buffer += trozo;
      while (buffer.includes('#')) {
        const i = buffer.indexOf('#'); const [c, ...p] = buffer.slice(1, i).split('|'); buffer = buffer.slice(i + 1);
        ordenes.push([Number(c), ...p]);
        if (c === '47') { enviar('$5'); setTimeout(() => !s.destroyed && enviar('7|123#'), 1); }
        else if (c === '57') { assert.equal(p[0], '100124'); enviar('$58|TEST#'); }
        else if (c === '39') enviar(`$39|1#${fallo === 'interrumpida' ? '$104|3|200|500|0#' : ''}$106|1|0#`);
        else if (c === '38') enviar('$38|1|EUR|#');
        else if (c === '40') enviar('$40|1|1#');
        else if (c === '43') enviar('$43|1|0#');
        else if (c === '79') enviar('$79|1|100,50000|9,0|EUR#');
        else if (c === '19') enviar(p[0] === '100' ? '$19|1|7#' : '$19|0|39|Value not supported.#');
        else if (c === '17') enviar('$17|1|EUR|100|3#');
        else if (c === '29') {
          if (fallo === 'corte') { s.destroy(); continue; }
          if (fallo !== 'sin-ack') enviar('$29|1#');
          enviar('$106|3|1#$108|500|500|0#$106|1|3#');
          if (fallo !== 'sin-disabled') enviar('$100|0||500|500|3|0#');
          if (fallo === 'duplicada') enviar('$100|0||500|500|3|0#');
        } else throw new Error(`Orden no prevista: ${c}`);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const puerto = server.address().port;
  const m = new MaquinaDirecta('127.0.0.1', puerto, '100001');
  m.intervalo = 5; m.timeoutOperacion = 100; m.mantenerViva = () => {};
  const orden = m.orden.bind(m); m.orden = (c, p) => orden(c, p, 150);
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-tcp-'));
  t.after(async () => { m.soltar(); for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); fs.rmSync(carpeta, { recursive: true, force: true }); });
  const diario = new DiarioCashKeeper(carpeta);
  const op = { id: 'tcp', tipo: fallo === 'niveles' ? 'mantenimiento' : 'salida', herramienta: fallo === 'niveles' ? {accion:'niveles'} : undefined, importe_centimos: 500, host: '127.0.0.1', puerto };
  let final;
  await operarDirecto(op, async (...r) => { final = r; }, { maquina: m, diario });
  return { final, ordenes, diario, op, m };
}
for (const fallo of ['', 'duplicada']) test(`TCP handshake fragmentado y evento terminal ${fallo || 'normal'}`, async t => {
  const r = await escenario(t, fallo); assert.equal(r.final[0], 'cobrada'); assert.equal(r.ordenes.filter(x => x[0] === 29).length, 1); assert.equal(r.diario.leer('tcp').final.resultado.fin.actual, 500);
});
test('TCP: error 39 en un valor vacío conserva niveles actuales de los recicladores admitidos', async t => {
  const r = await escenario(t, 'niveles');
  assert.equal(r.final[0], 'cobrada');
  assert.deepEqual(r.final[2].cambio, [{valor:100,unidades:7,divisa:'EUR'}]);
  assert.equal(r.diario.leer('tcp'), null);
  assert.ok(!r.ordenes.some(x => [9,11,12,13,14,29,30,42,52,67].includes(x[0])));
});
for (const fallo of ['corte', 'sin-ack', 'sin-disabled', 'interrumpida']) test(`TCP ${fallo}: bloquea sin reenviar Pay ni Discard`, async t => {
  const r = await escenario(t, fallo); assert.equal(r.final[0], 'error'); assert.equal(r.final[2].conciliar, true);
  const antes = r.ordenes.length;
  await operarDirecto({ ...r.op, id: 'otro' }, async () => {}, { maquina: r.m, diario: r.diario });
  assert.equal(r.ordenes.length, antes); assert.ok(!r.ordenes.some(x => x[0] === 52));
});

for (const mala of [false,true]) test(`Office consulta sin Startup ni dinero, clave ${mala?'incorrecta':'correcta'}`, async t => {
  const cmds=[];const ss=new Set();
  const srv=net.createServer(s=>{ss.add(s);s.on('close',()=>ss.delete(s));s.on('data',b=>{const c=b.toString();cmds.push(c);
    if(c==='$47#')s.write('$57|123#');
    else if(c.startsWith('$57|')){if(mala)s.end();else s.write('$58|TEST#');}
    else if(c==='$79|0#')s.write('$106|1|0#$79|1|100,100|3,2|EUR,USD#');
    else if(c==='$17#')s.write('$17|1|EUR|500|2#');
    else throw new Error('Office no admite '+c);
  });});
  srv.listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));
  t.after(async()=>{for(const s of ss)s.destroy();await new Promise(r=>srv.close(r));});
  const p=leerEfectivo('127.0.0.1',srv.address().port,mala?'1':'100001',500);
  if(mala)await assert.rejects(p,/clave/);else {const r=await p;assert.equal(r.cambio[1].divisa,'USD');assert.equal(r.recaudacion[0].unidades,2);}
  assert.ok(cmds.every(x=>/^\$(47|57|79|17)[|#]/.test(x)));
});

for (const caso of ['aceptar','caducar','error']) test(`TCP eventos manual: ${caso}`, async t => {
  let cliente; let estado=caso==='error'?6:1;const ordenes=[];
  const srv=net.createServer(s=>{cliente=s;s.on('error',()=>{});let b='';s.on('data',d=>{b+=d;while(b.includes('#')){const i=b.indexOf('#');const [c]=b.slice(1,i).split('|');b=b.slice(i+1);ordenes.push(Number(c));
    if(c==='47')s.write('$57|123#');else if(c==='57')s.write('$58|TEST#');else if(c==='39')s.write(`$39|1#$106|${estado}|0#`);
    else if(c==='40')s.write(`$40|1|${estado}#`);else if(c==='43')s.write('$43|1|0#');else if(c==='7'){estado=0;s.write('$7|1#');}
    else if(['3','32'].includes(c))s.write(`$${c}|1#`);else throw new Error(`No se permite ${c}`);
  }});});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const m=new MaquinaDirecta('127.0.0.1',srv.address().port,'100001');m.plazoPregunta=80;
  t.after(async()=>{m.soltar();cliente?.destroy();await new Promise(r=>srv.close(r));});
  await m.asegurar();
  if(caso==='error'){assert.equal(m.estado,6);await m.orden(7);assert.deepEqual(await m.orden(40),['0']);return;}
  cliente.write('$102|100,500|2,1#$113|1#$110|9|Retire billete#$105|5000|500|10000|0#');
  await new Promise(r=>setTimeout(r,15));
  const p=m.observaciones().pregunta;assert.equal(p.tipo,'proteccion_cambio');assert.equal(m.observaciones().billete_pendiente,true);assert.equal(m.observaciones().niveles_bajos.length,2);
  await m.responderPregunta('id-equivocado',true);assert.ok(!ordenes.includes(3));
  if(caso==='aceptar'){await m.responderPregunta(p.id,true);await m.responderPregunta(p.id,true);assert.equal(ordenes.filter(x=>x===3).length,1);assert.equal(m.observaciones().pregunta,null);}
  else {await new Promise(r=>setTimeout(r,110));assert.equal(ordenes.filter(x=>x===32).length,1);assert.ok(!ordenes.includes(3));}
  cliente.write('$113|0#');await new Promise(r=>setTimeout(r,10));assert.equal(m.observaciones().billete_pendiente,false);
});
