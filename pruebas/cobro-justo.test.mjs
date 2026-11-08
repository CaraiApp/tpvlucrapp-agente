// Final de un cobro que la máquina cuenta en reposo (CKVirtual): sin TCP ni máquina, con una máquina de juguete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { operarEnMaquina } from '../cashkeeper-operaciones.mjs';

async function cobrar(eventos, valueOut = '0', importe = 250) {
  const m = new EventEmitter();
  m.estado = 1; m.intervalo = 20;
  m.orden = async c => {
    if (c === 42) { eventos.forEach(([codigo, p], i) => setTimeout(() => m.emit(codigo, p), 10 * (i + 1))); return ['OK']; }
    if (c === 40) return ['1'];
    if (c === 43) return ['0'];
    if (c === 44) return [valueOut];
    return ['OK'];
  };
  let final;
  await operarEnMaquina(m, { tipo: 'cobro', importe_centimos: importe, propina_centimos: 0 }, async (estado, error, resultado, progreso) => {
    if (estado !== 'en_curso') final = { estado, progreso };
    return {};
  }).catch(e => { final = { estado: 'error', error: e.message, conciliar: e.conciliar }; });
  return final;
}

test('cobro de 2,50 € con 5 € y la vuelta avisada (CKVirtual): cobrado, sin revisión', async () => {
  const r = await cobrar([['107', ['250', '250', '0']], ['107', ['500', '250', '0']], ['108', ['200', '250', '0']], ['108', ['250', '250', '0']], ['100', ['0', '', '250', '250', '1', '0']]]);
  assert.equal(r.estado, 'cobrada');
  assert.deepEqual({ introducido: r.progreso.introducido, devuelto: r.progreso.devuelto }, { introducido: 500, devuelto: 250 });
});

test('cobro de 2,50 € con un billete devuelto por falta de cambio: cobrado lo justo', async () => {
  const r = await cobrar([['107', ['500', '250', '0']], ['107', ['250', '250', '0']], ['100', ['0', '', '250', '250', '1', '0']]]);
  assert.equal(r.estado, 'cobrada');
  assert.equal(r.progreso.introducido, 250);
});

test('vuelta a medias: queda para revisar', async () => {
  const r = await cobrar([['107', ['500', '250', '0']], ['108', ['200', '250', '0']], ['100', ['0', '', '250', '250', '1', '0']]]);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});

test('cobro de 10 € con un billete de 100 € (CKVirtual, 29-10): el final describe la vuelta de 90 €, cobrado sin revisión', async () => {
  const r = await cobrar([['107', ['10000', '1000', '0']], ['108', ['5000', '9000', '0']], ['108', ['9000', '9000', '0']], ['100', ['0', '', '9000', '9000', '1', '0']]], '9000', 1000);
  assert.equal(r.estado, 'cobrada');
  assert.deepEqual({ introducido: r.progreso.introducido, devuelto: r.progreso.devuelto }, { introducido: 10000, devuelto: 9000 });
});

test('la vuelta de 90 € que acaba en 80: queda para revisar', async () => {
  const r = await cobrar([['107', ['10000', '1000', '0']], ['108', ['8000', '9000', '0']], ['100', ['0', '', '8000', '9000', '1', '0']]], '8000', 1000);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});

test('cobro de 2,80 € con 20 € (máquina real, 5-11): cierra en reposo sin describir nada; la última salida (44) es la vuelta', async () => {
  const r = await cobrar([['107', ['2000', '280', '0']], ['108', ['720', '1720', '0']], ['100', ['0', '', '0', '0', '1', '0']]], '1720', 280);
  assert.equal(r.estado, 'cobrada');
  assert.deepEqual({ introducido: r.progreso.introducido, devuelto: r.progreso.devuelto }, { introducido: 2000, devuelto: 1720 });
});

test('el mismo cierre en reposo, pero la máquina dice que solo pagó 7,20 €: queda para revisar', async () => {
  const r = await cobrar([['107', ['2000', '280', '0']], ['108', ['720', '1720', '0']], ['100', ['0', '', '0', '0', '1', '0']]], '720', 280);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});

test('cierre en reposo sin describir nada y sin haber metido de más: no se inventa una vuelta', async () => {
  const r = await cobrar([['107', ['280', '280', '0']], ['100', ['0', '', '0', '0', '1', '0']]], '0', 280);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});

// Antes de dejar un cobro con vuelta para revisar, se le pregunta siempre a la máquina (0.8.13; Luis, 5-11): si su última
// salida es la vuelta (lo metido menos lo cobrado) y no queda crédito, vale aunque el final describa cualquier otra cosa.
test('la máquina real describe solo una parte de la vuelta (7,20 de 17,20) pero su última salida es la vuelta entera: cobrado', async () => {
  const r = await cobrar([['107', ['2000', '280', '0']], ['108', ['720', '1720', '0']], ['100', ['0', '', '720', '1720', '2', '0']]], '1720', 280);
  assert.equal(r.estado, 'cobrada');
  assert.deepEqual({ introducido: r.progreso.introducido, devuelto: r.progreso.devuelto }, { introducido: 2000, devuelto: 1720 });
});

test('el final describe otra cosa y la última salida no es la vuelta: queda para revisar (no se inventa)', async () => {
  const r = await cobrar([['107', ['2000', '280', '0']], ['108', ['720', '1720', '0']], ['100', ['0', '', '720', '1720', '2', '0']]], '1000', 280);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});

// El primer billete de un cobro puede avisar con el objetivo aún a 0 (máquina real, Kursaal 8-11: 41,40 € con 42 €, el billete
// de 20 € avisó «2000|0|0»): es nuestro, no de otra operación; lo confirman el final (PAYING: la vuelta de 0,60), el crédito
// a 0 y la última salida (0.8.16). Hasta la 0.8.15 iba a Incidencias con el dinero dentro, la vuelta dada y la mesa abierta.
test('cobro de 41,40 € con 42 € (máquina real, 8-11): el primer billete avisa con el objetivo a 0; cobrado sin revisión', async () => {
  const r = await cobrar([['107', ['2000', '0', '0']], ['107', ['4000', '4140', '0']], ['107', ['4200', '4140', '0']], ['108', ['10', '60', '0']], ['108', ['60', '60', '0']], ['100', ['0', '', '60', '60', '3', '0']]], '60', 4140);
  assert.equal(r.estado, 'cobrada');
  assert.deepEqual({ introducido: r.progreso.introducido, devuelto: r.progreso.devuelto }, { introducido: 4200, devuelto: 60 });
});

test('un ValueIN con otro objetivo (ni el nuestro ni 0) sigue siendo de otra operación: para revisar', async () => {
  const r = await cobrar([['107', ['2000', '1000', '0']], ['107', ['4200', '4140', '0']], ['108', ['60', '60', '0']], ['100', ['0', '', '60', '60', '3', '0']]], '60', 4140);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});

test('un ValueIN de otra operación (tercer campo) sigue siendo para revisar', async () => {
  const r = await cobrar([['107', ['2000', '0', '7']], ['107', ['4200', '4140', '0']], ['108', ['60', '60', '0']], ['100', ['0', '', '60', '60', '3', '0']]], '60', 4140);
  assert.equal(r.estado, 'error');
  assert.equal(r.conciliar, true);
});
