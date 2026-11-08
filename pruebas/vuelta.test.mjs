import test from 'node:test';
import assert from 'node:assert/strict';
import { clasificar, componerVuelta, describirPiezas } from '../cashkeeper-vuelta.mjs';

const niveles = (lista) => lista.map(([valor, unidades]) => ({ valor, unidades, divisa: 'EUR' }));
const maximos = (lista) => lista.map(([valor, unidades]) => ({ valor, unidades, divisa: 'EUR' }));

test('clasifica: sobrante por encima del umbral del máximo, escasa en o bajo el mínimo, normal lo demás', () => {
  const c = clasificar(niveles([[100, 5], [50, 100], [20, 50], [10, 10], [500, 3], [1000, 0]]), {
    maximos: maximos([[100, 60], [50, 120], [20, 60], [10, 60], [500, 20]]),
    minimoMonedas: 20,
    minimosBilletes: [{ valor: 500, unidades: 5 }],
  });
  assert.deepEqual(c.map((x) => [x.valor, x.clase]), [[100, 'escasa'], [50, 'sobrante'], [20, 'sobrante'], [10, 'escasa'], [500, 'escasa']]);
});

test('el ejemplo de Luis: 1,60 € con 1 € y 10 c escasos y 50 c y 20 c de sobra son dos de 50 y tres de 20', () => {
  const c = clasificar(niveles([[100, 5], [50, 100], [20, 50], [10, 10]]), { maximos: maximos([[100, 60], [50, 120], [20, 60], [10, 60]]), minimoMonedas: 20 });
  const r = componerVuelta(160, c);
  assert.deepEqual(r.piezas, [{ valor: 50, unidades: 2 }, { valor: 20, unidades: 3 }]);
  assert.equal(r.total, 5);
  assert.equal(describirPiezas(r.piezas), '2 × 0,50 € y 3 × 0,20 €');
});

test('10 c con muchas de 5 y pocas de 10: dos de 5', () => {
  const c = clasificar(niveles([[10, 5], [5, 400], [2, 50], [1, 50]]), { maximos: maximos([[10, 60], [5, 450], [2, 500], [1, 500]]), minimoMonedas: 20 });
  assert.deepEqual(componerVuelta(10, c).piezas, [{ valor: 5, unidades: 2 }]);
});

test('sin sobrantes ni escasas da el menor número de piezas, como la máquina', () => {
  const c = clasificar(niveles([[200, 30], [100, 30], [50, 30], [20, 30], [10, 30]]), { maximos: maximos([[200, 100], [100, 100], [50, 100], [20, 100], [10, 100]]), minimoMonedas: 5 });
  assert.deepEqual(componerVuelta(380, c).piezas, [{ valor: 200, unidades: 1 }, { valor: 100, unidades: 1 }, { valor: 50, unidades: 1 }, { valor: 20, unidades: 1 }, { valor: 10, unidades: 1 }]);
});

test('las escasas solo entran si no hay otra forma de dar el importe exacto', () => {
  // 30 c: con 20 c escasa y 10 c normal, sale 3 × 10 c (normales) antes que tocar la de 20.
  const c = clasificar(niveles([[20, 3], [10, 30]]), { maximos: maximos([[20, 60], [10, 60]]), minimoMonedas: 5 });
  assert.deepEqual(componerVuelta(30, c).piezas, [{ valor: 10, unidades: 3 }]);
  // 5 c solo con la escasa de 5 c: se usa, porque no hay otra forma.
  const d = clasificar(niveles([[5, 2], [10, 30]]), { maximos: maximos([[5, 60], [10, 60]]), minimoMonedas: 5 });
  assert.deepEqual(componerVuelta(5, d).piezas, [{ valor: 5, unidades: 1 }]);
});

test('no sale exacto o pasa del tope: null (la vuelta la da la máquina)', () => {
  const c = clasificar(niveles([[20, 10], [50, 10]]), { maximos: maximos([[20, 60], [50, 60]]) });
  assert.equal(componerVuelta(30, c), null);
  const d = clasificar(niveles([[1, 500]]), { maximos: maximos([[1, 500]]) });
  assert.equal(componerVuelta(20, d, { tope: 10 }), null);
  assert.deepEqual(componerVuelta(8, d, { tope: 10 }).piezas, [{ valor: 1, unidades: 8 }]);
  assert.equal(componerVuelta(0, c), null);
  assert.equal(componerVuelta(1.5, c), null);
  assert.equal(componerVuelta(50, []), null);
});

test('no pide más unidades de las que hay ni usa otras divisas', () => {
  const c = clasificar([{ valor: 100, unidades: 1, divisa: 'EUR' }, { valor: 100, unidades: 50, divisa: 'USD' }, { valor: 50, unidades: 2, divisa: 'EUR' }], { maximos: maximos([[100, 10], [50, 10]]) });
  const r = componerVuelta(200, c);
  assert.deepEqual(r.piezas, [{ valor: 100, unidades: 1 }, { valor: 50, unidades: 2 }]);
  assert.equal(componerVuelta(250, c), null);
});

test('una vuelta grande con billetes y monedas sale en milisegundos', () => {
  const c = clasificar(niveles([[5000, 5], [2000, 20], [1000, 20], [500, 20], [200, 50], [100, 50], [50, 50], [20, 50], [10, 50], [5, 400], [2, 600], [1, 700]]), {
    maximos: maximos([[5000, 20], [2000, 60], [1000, 60], [500, 60], [200, 100], [100, 100], [50, 100], [20, 100], [10, 100], [5, 450], [2, 650], [1, 750]]),
    minimoMonedas: 20,
  });
  const t = Date.now();
  const r = componerVuelta(9876, c, { tope: 12 });
  assert.ok(Date.now() - t < 500);
  assert.ok(r === null || r.piezas.reduce((s, p) => s + p.valor * p.unidades, 0) === 9876);
});
