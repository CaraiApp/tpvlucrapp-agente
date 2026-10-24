// Con una operación en marcha, el programa no suelta nunca la máquina: si se corta la conexión, se cierra a medio cobro
// (manual del integrador §8.2.3). Ni porque tarde en contestar, ni por un mensaje raro, ni por una clave nueva.
// Transporte TCP real en local contra una máquina sintética; sin hardware ni credenciales del local.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MaquinaDirecta, operarDirecto, maquinaDirecta } from '../tpvlucrapp-agente.mjs';
import { DiarioCashKeeper } from '../cashkeeper-seguro.mjs';

const pausa = ms => new Promise(r => setTimeout(r, ms));

/** Una máquina por TCP: entra con la clave, arranca y lo demás lo contesta `contestar(código, parámetros, enviar)`. */
async function maquinaTcp(t, contestar) {
  const ordenes = []; const sockets = new Set(); const registro = { entradas: 0, cerradas: 0 };
  const srv = net.createServer(s => {
    sockets.add(s); s.on('error', () => {}); s.on('close', () => { sockets.delete(s); registro.cerradas++; });
    let b = ''; const enviar = x => { if (!s.destroyed) s.write(x); };
    s.on('data', d => {
      b += d;
      while (b.includes('#')) {
        const i = b.indexOf('#'); const [c, ...p] = b.slice(1, i).split('|'); b = b.slice(i + 1);
        ordenes.push(Number(c));
        if (c === '47') { registro.entradas++; enviar('$57|123#'); }
        else if (c === '57') enviar('$58|TEST#');
        else if (c === '39') enviar('$39|1#$106|1|0#');
        else if (c === '38') enviar('$38|1|EUR|#');
        else contestar(c, p, enviar);
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const puerto = srv.address().port;
  const m = new MaquinaDirecta('127.0.0.1', puerto, '100001');
  // Los mismos plazos que en el local, en pequeño: paciencia 60 ms, «muda» a los 400 ms, aviso a los 30 ms.
  m.mantenerViva = () => {}; m.intervalo = 5; m.esperaOrden = 60; m.atrasoMaximo = 400; m.avisoLenta = 30; m.latidoCajon = 20;
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-sin-cortar-'));
  t.after(async () => { m.soltar(); for (const s of sockets) s.destroy(); await new Promise(r => srv.close(r)); fs.rmSync(carpeta, { recursive: true, force: true }); });
  return { m, ordenes, registro, puerto, diario: new DiarioCashKeeper(carpeta) };
}

/** Lleva un cobro de 3,20 € y apunta todo lo que se cuenta a la plataforma. */
async function cobrar(ctx, id, extra = {}) {
  const avisos = []; let final;
  await operarDirecto({ id, tipo: 'cobro', importe_centimos: 320, host: '127.0.0.1', puerto: ctx.puerto, ...extra }, async (estado, error, resultado, progreso) => {
    avisos.push({ estado, resultado, en: Date.now(), cerradas: ctx.registro.cerradas });
    // `cortada`: si el programa ya había soltado la conexión al apuntar el final (destroy() es inmediato en el cliente).
    if (estado !== 'en_curso') final = { estado, error, resultado, progreso, cortada: !ctx.m.conexion || ctx.m.conexion.destroyed };
  }, { maquina: ctx.m, diario: ctx.diario });
  return { avisos, final };
}

test('una pregunta de estado lenta a mitad de cobro no corta: se espera, no sale otra orden encima y el cobro acaba bien', async t => {
  let estado = 1; let retenida = false; const durante = [];
  const ctx = await maquinaTcp(t, (c, p, enviar) => {
    if (retenida) durante.push(c);
    if (c === '42') { estado = 2; enviar('$42|1#$106|2|1#'); }
    else if (c === '40' && estado === 2 && !retenida) {
      // Tarda 300 ms (cinco veces la paciencia) y, mientras, el cliente acaba de pagar.
      retenida = true;
      setTimeout(() => { estado = 1; enviar('$107|320|320|0#$106|1|2#$100|0||320|320|2|0#'); }, 250);
      setTimeout(() => { retenida = false; enviar('$40|1|2#'); }, 300);
    }
    else if (c === '40') enviar(`$40|1|${estado}#`);
    else if (c === '43') enviar('$43|1|0#');
    else if (c === '52') enviar('$52|1#');
    else throw new Error(`Orden no prevista ${c}`);
  });
  const { avisos, final } = await cobrar(ctx, 'lenta');
  assert.equal(final.estado, 'cobrada', final.error);
  assert.equal(final.progreso.introducido, 320);
  assert.equal(ctx.registro.entradas, 1, 'una sola conexión');
  assert.equal(ctx.registro.cerradas, 0, 'la conexión no se ha cerrado');
  assert.equal(final.cortada, false);
  assert.deepEqual(durante, [], 'no se mandó nada mientras la máquina no contestaba');
  assert.equal(ctx.ordenes.filter(c => c === 42).length, 1);
  assert.ok(avisos.some(a => a.estado === 'en_curso' && a.resultado?.maquina_lenta === true), 'la caja sabe que la máquina está tardando');
  assert.equal(final.resultado.maquina_lenta, false, 'y deja de avisarlo cuando contesta');
});

test('la respuesta que llega tarde no se toma por la de la orden siguiente', async t => {
  const tiempos = {};
  const ctx = await maquinaTcp(t, (c, p, enviar) => {
    if (c === '40' && tiempos.conectada) setTimeout(() => { tiempos.respuesta40 = Date.now(); enviar('$40|1|7#'); }, 150);
    else if (c === '40') enviar('$40|1|1#');
    else if (c === '43') { tiempos.llega43 = Date.now(); enviar('$43|1|25#'); }
  });
  await ctx.m.asegurar(); tiempos.conectada = true;
  ctx.m.ocupada = true;
  await assert.rejects(ctx.m.orden(40, [], 30), e => e.sinRespuesta === true);
  assert.deepEqual(await ctx.m.orden(43, [255]), ['25']);
  assert.ok(tiempos.llega43 >= tiempos.respuesta40, 'la 43 salió después de llegar la respuesta atrasada de la 40');
  ctx.m.ocupada = false;
  assert.equal(ctx.registro.cerradas, 0);
});

test('máquina muda a mitad de cobro: no se corta hasta acabar, queda para revisar y después se reinicia la conexión', async t => {
  let estado = 1; let muda = false; const despues = [];
  const ctx = await maquinaTcp(t, (c, p, enviar) => {
    if (muda) return despues.push(c);
    if (c === '42') { estado = 2; enviar('$42|1#$106|2|1#'); }
    else if (c === '40' && estado === 2) muda = true;
    else if (c === '40') enviar(`$40|1|${estado}#`);
    else if (c === '43') enviar('$43|1|0#');
  });
  ctx.m.timeoutOperacion = 900;
  const { final } = await cobrar(ctx, 'muda');
  assert.equal(final.estado, 'error');
  assert.equal(final.resultado.conciliar, true);
  assert.equal(final.cortada, false, 'la conexión seguía abierta al apuntar el final');
  assert.equal(ctx.diario.leer('muda').final.estado, 'error');
  await pausa(50);
  assert.equal(ctx.registro.cerradas, 1, 'acabada (y en el diario), se reinicia la conexión');
  assert.deepEqual(despues, [], 'no se le mandó nada más');
});

test('si tarda en confirmar la orden de cobro, la señal de vida sigue y el cobro acaba bien', async t => {
  let estado = 1;
  const ctx = await maquinaTcp(t, (c, p, enviar) => {
    if (c === '42') setTimeout(() => { estado = 1; enviar('$42|1#$106|2|1#$107|320|320|0#$106|1|2#$100|0||320|320|2|0#'); }, 250);
    else if (c === '40') enviar(`$40|1|${estado}#`);
    else if (c === '43') enviar('$43|1|0#');
    else if (c === '52') enviar('$52|1#');
  });
  const { avisos, final } = await cobrar(ctx, 'ack-lento');
  assert.equal(final.estado, 'cobrada', final.error);
  const enEspera = avisos.filter(a => a.estado === 'en_curso' && a.resultado?.maquina_lenta === true);
  assert.ok(enEspera.length >= 3, `señales de vida mientras esperaba: ${enEspera.length}`);
  assert.equal(final.cortada, false);
  assert.equal(ctx.registro.cerradas, 0);
});

test('un aviso con un dato raro a mitad de cobro no corta: el final llega igual y queda para revisar', async t => {
  let estado = 1;
  const ctx = await maquinaTcp(t, (c, p, enviar) => {
    if (c === '42') { enviar('$42|1#$106|2|1#$110|X9|Aviso roto#$107|320|320|0#$106|1|2#$100|0||320|320|2|0#'); estado = 1; }
    else if (c === '40') enviar(`$40|1|${estado}#`);
    else if (c === '43') enviar('$43|1|0#');
    else if (c === '52') enviar('$52|1#');
  });
  ctx.m.timeoutOperacion = 2000;
  const { final } = await cobrar(ctx, 'raro');
  assert.equal(final.estado, 'error');
  assert.match(final.error, /no se entiende/);
  assert.equal(final.resultado.conciliar, true);
  assert.equal(final.resultado.fin.actual, 320, 'se conserva lo que dijo la máquina');
  assert.equal(final.cortada, false);
  assert.equal(ctx.registro.entradas, 1);
  assert.equal(ctx.registro.cerradas, 0);
});

test('en reposo, una respuesta que no llega reinicia la conexión como siempre', async t => {
  let callar = false;
  const ctx = await maquinaTcp(t, (c, p, enviar) => { if (c === '40' && !callar) enviar('$40|1|1#'); });
  await ctx.m.asegurar(); callar = true;
  await assert.rejects(ctx.m.orden(40, [], 50), e => !e.sinRespuesta);
  await pausa(30);
  assert.equal(ctx.registro.cerradas, 1);
});

test('una clave nueva desde la oficina no suelta la máquina con una operación en marcha o esperando turno', () => {
  const a = maquinaDirecta('127.0.0.1', 1, '111111');
  a.ocupada = true;
  assert.equal(maquinaDirecta('127.0.0.1', 1, '222222'), a);
  a.ocupada = false; a.enCola = 1;
  assert.equal(maquinaDirecta('127.0.0.1', 1, '222222'), a);
  a.enCola = 0;
  const b = maquinaDirecta('127.0.0.1', 1, '222222');
  assert.notEqual(b, a);
  assert.equal(b.semilla, '222222');
  b.soltar();
});
