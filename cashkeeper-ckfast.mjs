// CKFast: C crea una intención una sola vez. Tras reinicio/corte solo se consulta S.
export async function operarCkfast(op, avisar, { diario, orden, intervalo = 1000, timeout = 20 * 60_000 }) {
  let liberar; let iniciada = false; let enviado = false;
  const terminar = async (estado, error, conciliar = false) => {
    const resultado = { protocolo: 'ckfast', ticket: op.ticket, conciliar };
    const cuerpo = { estado, ...(error ? { error } : {}), resultado };
    if (iniciada) diario.terminar(op.id, cuerpo);
    return avisar(estado, error, resultado);
  };
  try {
    liberar = diario.bloquear(op);
    const previa = diario.iniciar({ ...op, reanudar: false });
    if (previa?.final) return avisar(previa.final.estado, previa.final.error, previa.final.resultado);
    iniciada = true;
    enviado = !!previa || !!op.reanudar;
    if (!enviado) {
      diario.avance(op.id, { enviado: true, protocolo: 'ckfast', ticket: op.ticket });
      enviado = true;
      try {
        const r = await orden(op.orden);
        if (!['OK|Added', 'NOK|Already exists'].includes(r)) return terminar('error', 'CKMonitor rechazó o no reconoció la solicitud; revisa su estado', true);
      } catch { /* No reenviar C. Preguntar por el MISMO ticket. */ }
    }
    const limite = Date.now() + timeout;
    do {
      await avisar('en_curso').catch(() => {});
      let r;
      try { r = await orden(`S|${op.ticket}`); } catch { /* Resultado desconocido. */ }
      if (r === 'OK|OK') return terminar('cobrada');
      if (r === 'OK|Cancel') return terminar('cancelada');
      // Not found tras enviar tampoco autoriza a cobrar por otra vía.
      if (r === 'NOK|Not found') return terminar('error', 'CKMonitor no encuentra el ticket enviado. Requiere conciliación; no repetir.', true);
      await new Promise(r => setTimeout(r, intervalo));
    } while (Date.now() < limite);
    return terminar('error', 'No se ha confirmado el resultado en CKMonitor. Requiere conciliación; no repetir.', true);
  } catch (e) {
    return terminar('error', 'Operación detenida. Revisa el diario y CKMonitor antes de volver a operar.', enviado || !!e.conciliar);
  } finally { liberar?.(); }
}
