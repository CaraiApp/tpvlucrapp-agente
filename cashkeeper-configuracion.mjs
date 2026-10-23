// Manual V3 §§7.3–7.4, 9.2.1–9.2.2. Lista cerrada: nunca acepta órdenes Raw del navegador.
import { entero, inventario, niveles, reposoSeguro, seleccion } from './cashkeeper-seguro.mjs';

// Límites de la aplicación, más conservadores que Int32. Los importes son céntimos.
export const PROPIEDADES = {
  2: [0, 0], 3: [0, 0], 5: [0, 1], 6: [0, 1], 7: [0, 120000],
  9: [0, 10000], 10: [0, 100000000], 11: [0, 10000], 12: [0, 1],
  13: [0, 100], 14: [0, 50000], 15: [0, 1], 16: [0, 1440], 17: [0, 1], 18: [0, 1000000], 21: [0, 2],
};
export const CONSULTAS_MANUAL = ['parametros', 'informacion'];
export const ACCIONES_MANUAL = [...CONSULTAS_MANUAL, 'guardar_niveles', 'guardar_propiedades', 'limpiar', 'idioma', 'pantalla', 'mensaje'];
const opcional = async (fn, errores, nombre) => {
  try { return await fn(); }
  catch (e) { if (![34, 37, 38, 39].includes(e.codigo)) throw e; errores.push(`${nombre}: no disponible en este modelo (${e.codigo})`); return null; }
};
const vector = (valores, respuesta) => niveles(valores.join(','), respuesta, 'EUR');

export async function parametros(m) {
  const lectura = await inventario(m);
  if (lectura.divisa !== 'EUR') throw new Error('Configuración de denominaciones disponible para EUR');
  const errores = [];
  const propiedades = [];
  for (const id of [0, 1, ...Object.keys(PROPIEDADES).map(Number), 19, 20]) {
    const r = await opcional(() => m.orden(63, [id]), errores, `Propiedad ${id}`);
    if (r) propiedades.push({ id, valor: entero(r[0], 2147483647) });
  }
  const valores = lectura.cambio.filter(x => x.divisa === 'EUR').map(x => x.valor);
  const maximos = valores.length ? await opcional(() => m.orden(23, [valores.join(',')]), errores, 'Máximos') : null;
  const billetes = valores.filter(x => x >= 500);
  const minimos = billetes.length ? await opcional(() => m.orden(8, [billetes.join(',')]), errores, 'Mínimos de billetes') : null;
  const [estado] = await m.orden(40);
  const limites = entero(estado, 7) === 1 ? await opcional(() => m.orden(5), errores, 'Estado de niveles') : null;
  if (limites && limites.length !== 4) throw new Error('CheckLevels devolvió un resultado incompleto');
  return { ...lectura, propiedades,
    maximos: maximos ? vector(valores, maximos[0]) : [], minimos: minimos ? vector(billetes, minimos[0]) : [],
    ...(limites ? { estado_niveles: { bajo: entero(limites[0], 1) === 1, reciclador_lleno: entero(limites[1], 1) === 1, recaudacion_monedas: entero(limites[2], 2), recaudacion_billetes: entero(limites[3], 2) } } : {}),
    no_disponible: errores,
  };
}

export async function herramientaManual(m, h) {
  if (h.accion === 'parametros') return parametros(m);
  if (h.accion === 'informacion') {
    const no_disponible = [];
    const [divisa, otras = ''] = await m.orden(38);
    const identificacion = await opcional(() => m.orden(74), no_disponible, 'Identificación');
    const firmware = [];
    for (const dispositivo of [1, 2, 3]) {
      const r = await opcional(() => m.orden(54, [dispositivo]), no_disponible, `Firmware ${dispositivo}`);
      if (r) firmware.push({ dispositivo, version: String(r[0]).slice(0, 120) });
    }
    const contadores = await opcional(() => m.orden(24), no_disponible, 'Contadores de entrada');
    // El ejemplo Raw oficial devuelve Decimals antes de Multiplier (§9.2.1).
    const moneda = await opcional(() => m.orden(86, [divisa]), no_disponible, 'Datos de divisa');
    const quebranto = await opcional(() => m.orden(16, [0]), no_disponible, 'Quebranto acumulado');
    return { divisa, otras_divisas: otras.split(',').filter(Boolean), identificacion: String(identificacion?.[0] ?? '').slice(0, 120), firmware,
      ...(contadores ? { contadores: { monedas: entero(contadores[0], 2147483647), billetes: entero(contadores[1], 2147483647) } } : {}),
      ...(moneda ? { detalle_divisa: { decimales: entero(moneda[0], 8), multiplicador: entero(moneda[1], 2147483647) } } : {}),
      ...(quebranto ? { quebranto: entero(quebranto[0]) } : {}), no_disponible };
  }
  if (h.confirmado !== true) throw new Error('Confirma la modificación');
  await reposoSeguro(m);
  if (h.accion === 'guardar_niveles') {
    const lista = seleccion(h.denominaciones);
    const lectura = await inventario(m);
    if (lista.some(x => !lectura.cambio.some(y => y.divisa === 'EUR' && y.valor === x.valor))) throw new Error('Hay una denominación sin reciclador');
    if (h.nivel === 'minimo' && lista.some(x => x.valor < 500)) throw new Error('El mínimo de monedas se configura conjuntamente en sus ajustes');
    if (!['maximo', 'minimo'].includes(h.nivel)) throw new Error('Nivel no válido');
    const valores = lista.map(x => x.valor).join(','); const unidades = lista.map(x => x.unidades).join(',');
    await m.orden(h.nivel === 'maximo' ? 35 : 27, [valores, unidades]);
    const [leido] = await m.orden(h.nivel === 'maximo' ? 23 : 8, [valores]);
    if (leido !== unidades) throw new Error('El equipo no conservó los niveles solicitados; vuelve a leer su configuración');
    return { ...(await parametros(m)), configuracion_confirmada: true };
  }
  if (h.accion === 'guardar_propiedades') {
    if (!Array.isArray(h.propiedades) || !h.propiedades.length || h.propiedades.length > 19 || new Set(h.propiedades.map(x => x.id)).size !== h.propiedades.length) throw new Error('Lista de propiedades no válida');
    for (const p of h.propiedades) {
      const limite = PROPIEDADES[p.id];
      if (!limite || !Number.isSafeInteger(p.valor) || p.valor < limite[0] || p.valor > limite[1]) throw new Error('Propiedad fuera de los límites permitidos');
    }
    // Una modificación parcial se comunica como error; nunca se simula una transacción de hardware.
    for (const p of h.propiedades) {
      await m.orden(60, [p.id, p.valor]); const [actual] = await m.orden(63, [p.id]);
      if (entero(actual, 2147483647) !== p.valor) throw new Error(`El equipo no conservó la propiedad ${p.id}; revisa los ajustes antes de continuar`);
    }
    return { ...(await parametros(m)), configuracion_confirmada: true };
  }
  if (h.accion === 'limpiar') {
    if (!['completa', 'breve'].includes(h.modo)) throw new Error('Modo de limpieza no válido');
    await m.orden(6, [h.modo === 'completa' ? 0 : 1], 15000);
  } else if (h.accion === 'idioma') {
    if (!['es', 'en'].includes(h.idioma)) throw new Error('Idioma no válido');
    await m.orden(70, [h.idioma === 'es' ? 1 : 2]);
  } else if (h.accion === 'mensaje') {
    if (!Number.isSafeInteger(h.codigo) || h.codigo < 2 || h.codigo > 32 || h.codigo === 24 || typeof h.texto !== 'string' || h.texto.length > 20 || !/^[\x20-\x7e]*$/.test(h.texto) || /[#|$]/.test(h.texto)) throw new Error('Código o texto de pantalla no válido');
    await m.orden(71,[h.codigo,h.texto]);
  } else if (h.accion === 'pantalla') {
    const texto = x => typeof x === 'string' && x.length <= 20 && /^[\x20-\x7e]*$/.test(x) && !/[#|$]/.test(x);
    if (!texto(h.linea1) || !texto(h.linea2) || typeof h.grande !== 'boolean') throw new Error('Usa hasta 20 caracteres simples por línea, sin #, | ni $');
    const [auto] = await m.orden(63, [6]);
    if (entero(auto, 1) !== 1) throw new Error('Activa primero el texto manual en los ajustes de la máquina');
    await m.orden(10, [h.linea1, h.linea2, h.grande ? 1 : 0]);
  } else throw new Error('Herramienta no disponible');
  const [estado] = await m.orden(40);
  if (entero(estado, 7) !== 1) throw new Error('La máquina no terminó en reposo');
  return { estado: 1, configuracion_confirmada: true };
}
