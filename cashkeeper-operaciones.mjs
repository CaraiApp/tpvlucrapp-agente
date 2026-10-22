// Operaciones físicas: ninguna respuesta OK sustituye a Disabled (§9.4.2).
import { hastaDisabled, comprobarFin, limpiarCreditoConfirmado, inventario, entero, revision } from './cashkeeper-seguro.mjs';
const dormir = ms => new Promise(r => setTimeout(r, ms));
const total = xs => xs.reduce((s, x) => s + x.valor * x.unidades, 0);

export async function operarEnMaquina(m, op, avisar) {
  if (op.tipo === 'prueba') return avisar('cobrada', null, { estado: m.estado });
  if (op.tipo === 'vaciado') return retirar(m, op, avisar);
  if (op.tipo === 'cambio') return cambiar(m, avisar);
  const saca = ['salida', 'devolucion'].includes(op.tipo);
  const objetivo = entero(op.importe_centimos) + entero(op.propina_centimos ?? 0);
  entero(objetivo);
  const abierta = op.tipo === 'entrada' && objetivo === 0;
  const progreso = { fase: 'conectando', objetivo, introducido: 0, devuelto: 0 };
  let accion = null;
  const limite = Date.now() + 20 * 60_000;
  const contar = () => avisar('en_curso', null, null, { ...progreso });
  const meter = p => { progreso.introducido = entero(p[0]); progreso.fase = 'metiendo'; };
  const sacar = p => { progreso.devuelto = entero(p[0]); progreso.fase = saca ? 'pagando' : 'devolviendo'; };
  m.on('107', meter); m.on('108', sacar);
  try {
    await contar();
    const fin = await hastaDisabled(m, async () => {
      if (saca) { progreso.fase = 'pagando'; await m.orden(29, [objetivo, 0]); }
      else {
        if (op.tipo === 'entrada') { await m.orden(67); await m.orden(14); }
        if (!abierta) await m.orden(42, [objetivo, 1]);
        progreso.fase = 'esperando';
      }
    }, async () => {
      const r = await contar().catch(() => null);
      if (saca || accion) return;
      const [estado] = await m.orden(40);
      // Disable solo en ENABLED. Si valida, esperar a la siguiente lectura.
      if (entero(estado, 7) !== 2) return;
      if (r?.cancelar || Date.now() > limite) {
        accion = 'cancelar'; progreso.fase = 'cancelando'; await m.orden(9, [1]);
      } else if (abierta && r?.terminar) {
        // Disable congela el importe antes de leerlo; no hay carrera con otra moneda.
        accion = 'aceptar'; await m.orden(9, [0]);
      }
    });
    if (fin.cortada) throw revision('Se perdió la conexión durante el movimiento. Resultado incierto; no repetir.');
    if (saca) progreso.devuelto = fin.actual;
    else progreso.introducido = fin.actual;
    await contar().catch(() => {});
    await comprobarFin(m, fin);
    if (saca) {
      if (fin.actual !== objetivo || fin.objetivo !== objetivo) throw revision('Pago parcial o importe distinto del solicitado');
    } else if (accion === 'aceptar') {
      const [credito] = await m.orden(43, [fin.operacion]);
      if (entero(credito) !== fin.actual) throw revision('El crédito no coincide con el importe aceptado');
      progreso.objetivo = fin.actual;
      await limpiarCreditoConfirmado(m, fin.operacion);
    } else {
      const [salida] = await m.orden(44); progreso.devuelto = entero(salida);
      const esperado = accion === 'cancelar' ? fin.actual : fin.actual - objetivo;
      if (esperado < 0 || progreso.devuelto !== esperado || (accion !== 'cancelar' && fin.objetivo !== objetivo)) throw revision('El efectivo recibido y la devolución no cuadran');
      await limpiarCreditoConfirmado(m, fin.operacion);
    }
    const cancelada = accion === 'cancelar' || (abierta && fin.actual === 0);
    progreso.fase = cancelada ? 'cancelado' : 'hecho';
    return avisar(cancelada ? 'cancelada' : 'cobrada', null, { ...progreso, fin }, { ...progreso });
  } finally { m.off('107', meter); m.off('108', sacar); }
}

async function retirar(m, op, avisar) {
  if (!['monedas', 'billetes', 'todo'].includes(op.vaciar)) throw new Error('Selecciona la recaudación a retirar');
  const filtrar = xs => xs.filter(x => op.vaciar === 'todo' || (op.vaciar === 'monedas' ? x.valor < 500 : x.valor >= 500));
  const leer = async () => {
    const r = await inventario(m);
    if ([...r.cambio, ...r.recaudacion].some(x => x.divisa !== 'EUR')) throw new Error('Retirada multidivisa pendiente de validación');
    return { ...r, recaudacion: filtrar(r.recaudacion) };
  };
  const antes = await leer();
  const importe = entero(total(antes.recaudacion));
  const progreso = { fase: 'vaciando', objetivo: importe, introducido: 0, devuelto: 0 };
  if (!importe) return avisar('cancelada', 'La recaudación seleccionada está a cero', antes, progreso);
  // Desde aquí una persona puede haber retirado dinero: incluso sin enviar 11, un corte exige revisión.
  m.marcarRevision?.('retirada_manual_iniciada');
  const limite = Date.now() + 15 * 60_000;
  for (;;) {
    const r = await avisar('en_curso', null, antes, { ...progreso }).catch(() => null);
    if (r?.terminar) break;
    if (r?.cancelar || Date.now() > limite) throw revision('Retirada sin confirmar: comprueba que el efectivo sigue en recaudación. El contador no se ha modificado.');
    await dormir(m.intervalo ?? 1000);
  }
  const previa = await leer();
  if (JSON.stringify(previa.recaudacion) !== JSON.stringify(antes.recaudacion)) throw revision('El contador cambió durante la retirada; no se ha puesto a cero');
  await m.orden(11, [{ monedas: 1, billetes: 2, todo: 5 }[op.vaciar]]);
  const despues = await leer();
  if (total(despues.recaudacion) !== 0) throw revision('El contador de recaudación no está a cero');
  return avisar('cobrada', null, { ...despues, retirado: importe, contador_cero: true }, { ...progreso, devuelto: importe, fase: 'hecho' });
}

async function cambiar(m, avisar) {
  const progreso = { fase: 'esperando', objetivo: 0, introducido: 0, devuelto: 0 };
  let accion;
  const contar = resultado => avisar('en_curso', null, resultado, { ...progreso });
  const meter = p => { progreso.introducido = entero(p[0]); progreso.fase = 'metiendo'; };
  m.on('107', meter);
  let fin;
  const limite = Date.now() + 20 * 60_000;
  try {
    fin = await hastaDisabled(m, () => m.orden(14), async () => {
      const r = await contar().catch(() => null);
      if (accion) return;
      const [estado] = await m.orden(40);
      if (entero(estado, 7) !== 2) return;
      if (r?.cancelar || Date.now() > limite) { accion = 'cancelar'; await m.orden(9, [1]); }
      else if (r?.terminar) { accion = 'aceptar'; await m.orden(9, [0]); }
    });
  } finally { m.off('107', meter); }
  await comprobarFin(m, fin);
  progreso.introducido = progreso.objetivo = fin.actual;
  if (accion === 'cancelar') {
    const [valor] = await m.orden(44); progreso.devuelto = entero(valor);
    if (progreso.devuelto !== fin.actual) throw revision('La cancelación no devolvió todo el crédito');
    await limpiarCreditoConfirmado(m, fin.operacion);
    return avisar('cancelada', null, { fin }, { ...progreso, fase: 'cancelado' });
  }
  if (accion !== 'aceptar') throw revision('Final inesperado de la introducción de cambio');
  const [credito] = await m.orden(43, [fin.operacion]);
  if (entero(credito) !== fin.actual) throw revision('El crédito de cambio no coincide');
  // La deuda queda en el diario y en el progreso, antes de quitar el crédito de la máquina.
  m.marcarRevision?.('cambio_aceptado', { introducido: fin.actual, devuelto: 0 });
  await contar().catch(() => {});
  await limpiarCreditoConfirmado(m, fin.operacion);
  const hasta = Date.now() + 15 * 60_000;
  while (progreso.devuelto < progreso.introducido) {
    const lectura = await inventario(m);
    if (lectura.cambio.some(x => x.divisa !== 'EUR')) throw revision('Cambio multidivisa pendiente de validación');
    progreso.fase = 'eligiendo';
    let pedido;
    do {
      pedido = await contar(lectura).catch(() => null);
      if (pedido?.cancelar || pedido?.seleccion || Date.now() > hasta) break;
      await dormir(m.intervalo ?? 1000);
    } while (true);
    const falta = progreso.introducido - progreso.devuelto;
    const cancelar = pedido?.cancelar || Date.now() > hasta;
    const lista = pedido?.seleccion;
    if (!cancelar && (!Array.isArray(lista) || new Set(lista.map(x => x.valor)).size !== lista.length || lista.some(x => !Number.isSafeInteger(x.valor) || !Number.isSafeInteger(x.unidades) || x.unidades <= 0 || x.unidades > (lectura.cambio.find(n => n.valor === x.valor)?.unidades ?? 0)) || total(lista) !== falta)) throw revision('Selección de cambio inválida; no se ha pagado');
    progreso.fase = cancelar ? 'devolviendo' : 'pagando';
    await contar().catch(() => {});
    // Sin reintento ante rechazo, pago parcial o corte. El saldo se conserva para revisión.
    const pagado = await hastaDisabled(m, () => cancelar ? m.orden(29, [falta, 0]) : m.orden(30, [lista.map(x => x.valor).join(','), lista.map(x => x.unidades).join(','), 0]), () => contar().catch(() => {}));
    if (!pagado.cortada) progreso.devuelto += pagado.actual;
    await contar().catch(() => {});
    await comprobarFin(m, pagado);
    if (pagado.actual !== falta || pagado.objetivo !== falta) throw revision('Cambio parcial: revisa el importe entregado y el pendiente');
    return avisar(cancelar ? 'cancelada' : 'cobrada', null, { ...await inventario(m), fin: pagado }, { ...progreso, fase: cancelar ? 'cancelado' : 'hecho' });
  }
  return avisar('cancelada', 'No se introdujo efectivo', { fin }, { ...progreso, fase: 'cancelado' });
}
