// Recuperación explícita de ProcessInterrupted, manual §7.5. Nunca reintenta una orden física.
import { entero, hastaDisabled, limpiarCreditoConfirmado, revision } from './cashkeeper-seguro.mjs';

export function validarRecuperacion(anterior, pedido, interrumpida) {
  const p = pedido.interrumpida;
  const terminal = pedido.origen === 'terminal'; const f = anterior.final?.resultado?.fin;
  const evidencia = terminal && !interrumpida && f?.estado === 3 && f.error > 0 && f.operacion === 0 && f.actual === anterior.final?.progreso?.devuelto
    ? {estado:3,valor:f.actual,objetivo:f.objetivo,operacion:0} : terminal ? null : interrumpida;
  if (!pedido.id || !p || !evidencia || ['estado', 'valor', 'objetivo', 'operacion'].some(k => p[k] !== evidencia[k]) || p.operacion !== 0)
    throw revision('La interrupción actual no coincide con la revisión autorizada');
  for (const k of ['valor', 'objetivo']) entero(p[k]);
  const objetivo = anterior.objetivo + (anterior.propina ?? 0);
  const entrada = [2, 7].includes(p.estado);
  const salida = p.estado === 3;
  const accion = pedido.accion;
  if (entrada) {
    if (!['cobro', 'entrada', 'cambio'].includes(anterior.tipo) || ![9, 14, 42, 67].includes(anterior.comando) || p.objetivo !== objetivo)
      throw revision('No se puede asociar esta entrada a la operación original');
    if (accion === 'devolver') return { entrada, objetivo: 0, estado: 'cancelada' };
    if (accion === 'conservar' && anterior.tipo === 'entrada' && p.valor > 0) return { entrada, objetivo: p.valor, estado: 'cobrada' };
    if (accion === 'continuar' && ['cobro', 'entrada'].includes(anterior.tipo) && objetivo > 0) return { entrada, objetivo, estado: 'cobrada' };
  } else if (salida) {
    const esperado = anterior.tipo === 'cambio' ? anterior.saldo?.introducido : objetivo;
    if (!['salida', 'devolucion', 'cambio'].includes(anterior.tipo) || ![29, 30, 87].includes(anterior.comando) || p.objetivo !== esperado || p.valor > p.objetivo)
      throw revision('No se puede asociar este pago a la operación original');
    if (accion === 'continuar' && p.valor < p.objetivo) return { entrada: false, objetivo: p.objetivo, restante: p.objetivo - p.valor, estado: 'cobrada' };
    if (accion === 'cerrar_pago' && anterior.tipo === 'salida') return { entrada: false, objetivo: p.valor, restante: 0, estado: p.valor ? 'cobrada' : 'cancelada' };
  }
  throw revision('La acción no es compatible con esta interrupción');
}

/** guardar → enviar una vez → Disabled → guardar resultado → confirmar servidor. Un corte mantiene el bloqueo. */
export async function recuperarInterrupciones(m, op, diario, consultar, informar) {
  return m.enTurno(async () => {
    const liberar = diario.bloquear(op); m.ocupada = true;
    try {
      for (const anterior of diario.pendientesRecuperacion(op)) {
        const pedido = await consultar(anterior.id);
        if (!pedido?.id || !pedido?.accion) continue;
        let local = diario.leer(anterior.id);
        if (local.recuperacion?.id === pedido.id) {
          if (local.recuperacion.final) {
            const r = await informar(anterior.id, { recuperacion_id: pedido.id, ...local.recuperacion.final });
            if (r?.resuelta) diario.guardar(anterior.id, { ...local, recuperacion: { ...local.recuperacion, sincronizada: true } });
          } else await informar(anterior.id, { recuperacion_id: pedido.id, estado: 'error', error: 'La recuperación se interrumpió. No se repite; comprueba el estado y el efectivo.', enviada:local.recuperacion.enviado === true });
          continue;
        }
        if (local.recuperacion && !local.recuperacion.sincronizada) throw revision('Hay una recuperación anterior pendiente de comprobar');
        let enviado = false;
        try {
          if (pedido.expira_en && Date.parse(pedido.expira_en) <= Date.now()) throw revision('La autorización ha caducado. Consulta de nuevo y confirma otra recuperación');
          await m.asegurar();
          const plan = validarRecuperacion(local, pedido, m.interrumpida);
          const [estado] = await m.orden(40); const [divisa] = await m.orden(38);
          if (entero(estado, 7) !== 1 || divisa !== 'EUR' || m.eventoInesperado) throw revision('La máquina no está preparada para recuperar esta operación');
          if (pedido.origen === 'terminal') {
            const [salida] = await m.orden(44); const [credito] = await m.orden(43,[255]);
            if (entero(salida) !== pedido.interrumpida.valor || entero(credito) !== 0) throw revision('El último pago o el crédito ha cambiado; no se puede recuperar con esta evidencia');
          }
          // El crédito debe corresponder exactamente al evento de interrupción de entrada.
          if (plan.entrada) { const [credito] = await m.orden(43, [0]); if (entero(credito) !== pedido.interrumpida.valor) throw revision('El crédito no coincide con la interrupción'); }
          local = { ...local, recuperacion: { ...pedido, anterior: local.final ?? null, iniciada_en: new Date().toISOString() } };
          diario.guardar(anterior.id, local);
          m.antesDeEnviar = codigo => {
            if ([3, 9, 29, 32, 42, 52, 68].includes(codigo)) {
              enviado = true; local = { ...local, recuperacion: { ...local.recuperacion, comando: codigo, enviado: true } }; diario.guardar(anterior.id, local);
            }
          };
          const progreso = { fase: plan.entrada ? 'metiendo' : 'pagando', objetivo: plan.objetivo, introducido: plan.entrada ? pedido.interrumpida.valor : anterior.tipo === 'cambio' ? plan.objetivo : 0, devuelto: plan.entrada ? 0 : pedido.interrumpida.valor };
          const contar = async () => {
            const r = await informar(anterior.id, { recuperacion_id: pedido.id, estado: 'en_curso', progreso, ...(m.observaciones?.() ?? {}) });
            if (r?.decision && m.responderPregunta) await m.responderPregunta(r.decision.id, r.decision.aceptar === true);
          };
          const meter = p => { if (p[2] !== '0') throw revision('Evento de otra operación'); progreso.introducido = entero(p[0]); };
          const sacar = p => { if (p[2] !== '0') throw revision('Evento de otra operación'); progreso.devuelto = (plan.entrada ? 0 : pedido.interrumpida.valor) + entero(p[0]); };
          m.on('107', meter); m.on('108', sacar);
          let fin;
          try {
            await contar();
            if (pedido.accion === 'cerrar_pago') {
              await m.orden(68); // No paga; cierra la parte que el responsable decidió no continuar.
            } else {
              fin = await hastaDisabled(m, () => plan.entrada ? m.orden(42, [plan.objetivo, 1]) : m.orden(29, [plan.restante, 0]), contar);
              if (fin.cortada || fin.error || fin.operacion !== 0 || m.eventoInesperado) throw revision('La recuperación no terminó correctamente; no repetir');
              if (plan.entrada) {
                const vacia = plan.objetivo === 0 && fin.actual === 0 && pedido.interrumpida.valor === 0 && progreso.introducido === 0 && progreso.devuelto === 0;
                progreso.introducido = fin.actual;
                if (!vacia) progreso.devuelto = entero((await m.orden(44))[0]);
                if (![2,7].includes(fin.estado) || fin.actual < pedido.interrumpida.valor || fin.objetivo !== plan.objetivo || fin.actual - progreso.devuelto !== plan.objetivo) throw revision('No cuadra el efectivo de la recuperación');
                if (!vacia) await limpiarCreditoConfirmado(m, 0);
              } else {
                if (fin.estado !== 3 || fin.actual !== plan.restante || fin.objetivo !== plan.restante) throw revision('La recuperación del pago fue parcial');
                progreso.devuelto = pedido.interrumpida.valor + fin.actual;
              }
            }
          } finally { m.off('107', meter); m.off('108', sacar); }
          const [finalEstado] = await m.orden(40); const [credito] = await m.orden(43, [255]);
          if (entero(finalEstado, 7) !== 1 || entero(credito) !== 0) throw revision('Quedó crédito o actividad después de recuperar');
          progreso.fase = plan.estado === 'cancelada' ? 'cancelado' : 'hecho';
          const final = { estado: plan.estado, progreso, resultado: { fin, recuperacion: { origen:pedido.origen ?? "interrupcion", interrumpida: pedido.interrumpida, accion: pedido.accion, estado: 1, credito: 0 }, conciliar: false } };
          const nuevo = { ...local, final, recuperacion: { ...local.recuperacion, final, terminada_en: new Date().toISOString() } };
          diario.guardar(anterior.id, nuevo); m.interrumpida = null;
          if ((await informar(anterior.id, { recuperacion_id: pedido.id, ...final }))?.resuelta) diario.guardar(anterior.id, { ...nuevo, recuperacion: { ...nuevo.recuperacion, sincronizada: true } });
        } catch (e) {
          // Antes de enviar se puede revisar de nuevo; después, el intento queda durablemente bloqueado.
          if (!enviado && local.recuperacion?.id === pedido.id && !local.recuperacion.final) {
            const {recuperacion: _intento, ...sinEnvio} = local; diario.guardar(anterior.id, sinEnvio);
          }
          await informar(anterior.id, { recuperacion_id: pedido.id, estado: 'error', enviada:enviado, error: `${e.message}${enviado ? ' No se repetirá la orden enviada.' : ''}`.slice(0, 300) }).catch(() => {});
        } finally { m.antesDeEnviar = null; }
      }
    } finally { m.ocupada = false; liberar(); }
  });
}
