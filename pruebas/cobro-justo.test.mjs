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
