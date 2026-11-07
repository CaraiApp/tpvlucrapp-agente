// La vuelta con lo que sobra (Luis, 7-11: «si hay muchas monedas de 5 céntimos y pocas de 10, que me dé dos de 5»;
// «1,60 € con 1 € y 10 c escasos y 50 c y 20 c de sobra: dos de 50 y tres de 20»). La máquina siempre da la vuelta con el
// menor número de piezas y no se le puede configurar otra cosa; con PaySpecific (30) se le dice con qué piezas pagar, y la
// composición la decide esto, con los niveles y los máximos y mínimos que ya tiene la máquina:
//   - sobrante: está por encima del umbral de su máximo (de serie el 80 %): se usa primero;
//   - escasa: en o por debajo de su mínimo (los billetes, el suyo; las monedas, el común, propiedad 18): solo si no hay
//     otra forma de dar el importe exacto;
//   - normal: lo demás.
// Dentro de cada clase, el menor número de piezas. Si no sale exacto o pasa del tope de piezas, la vuelta la da la máquina
// como siempre (29 Pay). Todo son enteros en céntimos y solo EUR.

/** Lo que cuesta cada pieza según su clase: una pieza normal vale más que cualquier cantidad razonable de sobrantes. */
export const PESO = { sobrante: 1, normal: 1000, escasa: 1_000_000 };
export const UMBRAL_DE_SERIE = 80;
export const TOPE_DE_SERIE = 10;
/** Por encima de esto (10.000 €) no se compone: no es una vuelta de un cobro. */
const IMPORTE_MAXIMO = 1_000_000;

const entero = (x) => Number.isSafeInteger(x) && x >= 0;

/** Clasifica lo que hay para dar cambio con los máximos (23), el mínimo común de monedas (propiedad 18) y los mínimos de billetes (8). */
export function clasificar(niveles, { maximos = [], minimoMonedas = 0, minimosBilletes = [], umbralPct = UMBRAL_DE_SERIE } = {}) {
  const umbral = Math.min(100, Math.max(1, Number(umbralPct) || UMBRAL_DE_SERIE)) / 100;
  const salida = [];
  for (const x of niveles ?? []) {
    if (!x || (x.divisa && x.divisa !== 'EUR') || !entero(x.valor) || x.valor <= 0 || !entero(x.unidades) || x.unidades <= 0) continue;
    const maximo = maximos.find((y) => y.valor === x.valor)?.unidades ?? 0;
    const minimo = x.valor >= 500 ? (minimosBilletes.find((y) => y.valor === x.valor)?.unidades ?? 0) : minimoMonedas;
    const clase = entero(maximo) && maximo > 0 && x.unidades >= Math.ceil(maximo * umbral) ? 'sobrante' : entero(minimo) && minimo > 0 && x.unidades <= minimo ? 'escasa' : 'normal';
    salida.push({ valor: x.valor, unidades: x.unidades, clase });
  }
  return salida;
}

/**
 * Compone `importe` con las denominaciones clasificadas (mochila acotada por partición binaria, con el coste de cada
 * clase). Devuelve `{ piezas: [{ valor, unidades }], total, clases }` o null si no sale exacto o pasa del tope de piezas.
 */
export function componerVuelta(importe, clasificadas, { tope = TOPE_DE_SERIE } = {}) {
  if (!entero(importe) || importe <= 0 || importe > IMPORTE_MAXIMO) return null;
  const limite = Math.max(1, Math.min(60, Number(tope) || TOPE_DE_SERIE));
  const items = [];
  for (const d of clasificadas ?? []) {
    const peso = PESO[d.clase];
    if (!peso || !entero(d.valor) || d.valor <= 0) continue;
    let resto = Math.min(d.unidades, Math.floor(importe / d.valor), limite);
    for (let k = 1; resto > 0; k *= 2) {
      const n = Math.min(k, resto);
      items.push({ valor: d.valor, n, coste: peso * n });
      resto -= n;
    }
  }
  if (items.length === 0) return null;
  const INF = Number.POSITIVE_INFINITY;
  const mejor = new Float64Array(importe + 1).fill(INF);
  mejor[0] = 0;
  // La decisión de cada etapa se guarda aparte: así se reconstruye hacia atrás sin confundirla con etapas posteriores.
  const tomado = items.map(() => new Uint8Array(importe + 1));
  items.forEach((it, i) => {
    const salto = it.valor * it.n;
    for (let a = importe; a >= salto; a--) {
      const c = mejor[a - salto] + it.coste;
      if (c < mejor[a]) {
        mejor[a] = c;
        tomado[i][a] = 1;
      }
    }
  });
  if (mejor[importe] === INF) return null;
  const unidades = new Map();
  let a = importe;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!tomado[i][a]) continue;
    const it = items[i];
    unidades.set(it.valor, (unidades.get(it.valor) ?? 0) + it.n);
    a -= it.valor * it.n;
  }
  if (a !== 0) return null;
  const piezas = [...unidades].map(([valor, n]) => ({ valor, unidades: n })).sort((x, y) => y.valor - x.valor);
  const total = piezas.reduce((s, p) => s + p.unidades, 0);
  if (total > limite) return null;
  const clases = Object.fromEntries(piezas.map((p) => [p.valor, clasificadas.find((d) => d.valor === p.valor)?.clase ?? 'normal']));
  return { piezas, total, clases };
}

/** Para enseñarlo: «2 × 0,50 € y 3 × 0,20 €». */
export function describirPiezas(piezas) {
  const euros = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
  const partes = (piezas ?? []).map((p) => `${p.unidades} × ${euros(p.valor)}`);
  return partes.length <= 1 ? partes.join('') : `${partes.slice(0, -1).join(', ')} y ${partes.at(-1)}`;
}
