// Contrato de seguridad Raw Sockets. Manual V.3, revisión 09/07/2026, §§7.2, 8.2, 9.2 y 9.4.2.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const EURO = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
export function entero(valor, max = 100_000_000) {
  if (!/^\d+$/.test(String(valor)) || !Number.isSafeInteger(Number(valor)) || Number(valor) > max) throw new Error('Dato entero no válido de CashKeeper');
  return Number(valor);
}
export function revision(mensaje) { return Object.assign(new Error(mensaje), { conciliar: true }); }
export function disabled(p) {
  if (p.length !== 6) throw new Error('Evento Disabled incompleto');
  return { error: entero(p[0]), texto: p[1], actual: entero(p[2]), objetivo: entero(p[3]), estado: entero(p[4], 7), operacion: entero(p[5], 255) };
}
export function niveles(valores = '', cantidades = '', divisas = 'EUR') {
  if (!valores && !cantidades) return [];
  const vs = String(valores).split(','); const ns = String(cantidades).split(','); const ds = String(divisas).split(',');
  if (vs.length !== ns.length || (ds.length !== 1 && ds.length !== vs.length)) throw new Error('Niveles incompletos de CashKeeper');
  const vistos = new Set();
  return vs.map((v, i) => {
    const valor = entero(v); const unidades = entero(ns[i], 1_000_000); const divisa = (ds.length === 1 ? ds[0] : ds[i]).trim().toUpperCase();
    const clave = `${divisa}:${valor}`;
    if (!valor || !/^[A-Z]{3}$/.test(divisa) || vistos.has(clave)) throw new Error('Denominación no válida o duplicada');
    vistos.add(clave); return { valor, unidades, divisa };
  });
}
export function seleccion(lista, campo = 'unidades') {
  if (!Array.isArray(lista) || !lista.length || lista.length > 60) throw new Error('Elige las denominaciones');
  const vistos = new Set();
  return lista.map(x => {
    if (!EURO.includes(x.valor) || vistos.has(x.valor)) throw new Error('Denominación no válida o duplicada');
    vistos.add(x.valor); const n = entero(x[campo], campo === 'estado' ? 2 : 1_000_000);
    if (campo === 'estado' && n === 1 && x.valor >= 500) throw new Error('Aceptar sin pagar solo es válido para monedas (§9.2.1)');
    return { valor: x.valor, [campo]: n };
  });
}

/** Un OK solo acepta la orden. Nunca StateChange=IDLE como sustituto de Disabled. */
export async function hastaDisabled(m, empezar, cada = async () => {}, { timeout = m.timeoutOperacion ?? 21 * 60_000, intervalo = m.intervalo ?? 1000 } = {}) {
  let resolver; let fallo; let terminado = false;
  const fin = new Promise(r => { resolver = r; });
  const alFin = p => { try { const f = disabled(p); if (f.operacion !== 0) throw revision('Disabled pertenece a otra operación'); m.evidenciaFin = f; resolver(f); } catch (e) { fallo = e; resolver(null); } terminado = true; };
  const alCorte = () => { terminado = true; resolver({ cortada: true }); };
  const timer = setTimeout(() => { fallo = new Error('No llegó Disabled: resultado incierto. Requiere conciliación; no repetir.'); terminado = true; resolver(null); }, timeout);
  m.esperandoDisabled = true;
  m.once('100', alFin); m.once('cortada', alCorte);
  try {
    await empezar();
    while (!terminado) {
      let t;
      await Promise.race([fin, new Promise(r => { t = setTimeout(r, intervalo); })]);
      clearTimeout(t);
      if (!terminado) await cada();
    }
    if (fallo) throw fallo;
    return await fin;
  } finally { m.esperandoDisabled = false; clearTimeout(timer); m.off('100', alFin); m.off('cortada', alCorte); }
}

/** Diario durable antes de mover dinero; nunca guarda semilla, token, orden de acceso ni nombres. */
export class DiarioCashKeeper {
  constructor(directorio) { this.directorio = directorio; }
  archivo(id) { return path.join(this.directorio, createHash('sha256').update(id).digest('hex') + '.json'); }
  leer(id) {
    try { return JSON.parse(fs.readFileSync(this.archivo(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw revision('Diario CashKeeper ilegible: no se permite operar'); }
  }
  guardar(id, valor) {
    fs.mkdirSync(this.directorio, { recursive: true, mode: 0o700 });
    const destino = this.archivo(id); const tmp = destino + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(valor)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, destino);
    if (process.platform !== 'win32') { const d = fs.openSync(this.directorio, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
  }
  iniciar(op) {
    const huella = createHash('sha256').update(JSON.stringify([op.host.toLowerCase(), op.puerto, op.tipo, op.importe_centimos, op.propina_centimos ?? 0, op.vaciar, op.herramienta, op.orden])).digest('hex');
    const anterior = this.leer(op.id);
    if (anterior) {
      if (anterior.huella !== huella) throw revision('La operación ya existe con otros datos; no se repetirá');
      return anterior;
    }
    const maquina = createHash('sha256').update(`${op.host.toLowerCase()}:${op.puerto}`).digest('hex');
    fs.mkdirSync(this.directorio, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(this.directorio).filter(f => f.endsWith('.json'))) {
      let previo;
      try { previo = JSON.parse(fs.readFileSync(path.join(this.directorio, f), 'utf8')); } catch { throw revision('Diario CashKeeper ilegible: requiere revisión'); }
      if (previo.maquina === maquina && (!previo.final || previo.final.resultado?.conciliar)) throw revision('La máquina tiene una operación pendiente de conciliación. No repetir ni cambiar a CKFast.');
    }
    if (op.reanudar) throw revision('Operación ya enviada sin evidencia local durable. Requiere conciliación; no repetir.');
    this.guardar(op.id, { id: op.id, huella, maquina, tipo: op.tipo, objetivo: op.importe_centimos, iniciada: new Date().toISOString() });
    return null;
  }
  terminar(id, final) { const anterior = this.leer(id); if (anterior) this.guardar(id, { ...anterior, final, terminada: new Date().toISOString() }); }
  avance(id, datos) { const anterior = this.leer(id); if (!anterior) throw revision('Falta el diario durable'); this.guardar(id, { ...anterior, ...datos }); }
  bloquear(op) {
    fs.mkdirSync(this.directorio, { recursive: true, mode: 0o700 });
    const archivo = this.archivo(`lock:${op.host.toLowerCase()}:${op.puerto}`) + '.lock';
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(archivo, 'wx', 0o600);
        fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); fs.closeSync(fd);
        return () => fs.unlinkSync(archivo);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number(fs.readFileSync(archivo, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid < 1) throw revision('Bloqueo local ilegible: requiere revisión');
        try { process.kill(pid, 0); } catch (error) {
          if (error.code === 'ESRCH') { fs.unlinkSync(archivo); continue; }
          throw revision('No se puede verificar el propietario del CashKeeper');
        }
        throw revision('Otro proceso está operando este CashKeeper');
      }
    }
    throw revision('No se pudo reservar el CashKeeper');
  }
}

export const esConsultaHerramienta = op => op.tipo === 'mantenimiento' && ['diagnostico', 'niveles', 'inhibiciones'].includes(op.herramienta?.accion);
export async function diagnostico(m) {
  await m.asegurar();
  const [estado] = await m.orden(40);
  const [credito] = await m.orden(43, [255]);
  return { estado: entero(estado, 7), credito: entero(credito), interrumpida: m.interrumpida ?? null, conciliar: !!m.interrumpida || entero(credito) > 0 || !!m.eventoInesperado };
}
export async function reposoSeguro(m) {
  const d = await diagnostico(m);
  const [principal] = await m.orden(38);
  if (principal !== 'EUR') throw new Error('Operativa física validada solo para la divisa principal EUR');
  if (d.estado !== 1 || d.conciliar) throw revision('La máquina tiene crédito, una operación interrumpida o un estado sin resolver. Requiere conciliación.');
}
export async function comprobarFin(m, fin) {
  if (fin.cortada || fin.error) throw revision(`Operación interrumpida o parcial${fin.error ? ` (error ${fin.error}, importe ${fin.actual})` : ''}. Requiere conciliación; no repetir.`);
  const [estado] = await m.orden(40);
  if (entero(estado, 7) !== 1 || m.interrumpida) throw revision('Disabled no quedó en reposo: requiere conciliación');
}
export async function limpiarCreditoConfirmado(m, operacion) {
  await m.orden(52, [operacion]);
  const [credito] = await m.orden(43, [operacion]);
  if (entero(credito) !== 0) throw revision('Sigue habiendo crédito pendiente después de finalizar');
}
export async function inventario(m) {
  const [principal] = await m.orden(38);
  if (!/^[A-Z]{3}$/.test(principal)) throw new Error('Divisa principal no válida');
  const [v, n, d] = await m.orden(79, [0]);
  let cambio = niveles(v, n, d || principal);
  const principales = cambio.filter(x => x.divisa === principal).map(x => x.valor).join(',');
  if (principales) {
    const [actuales] = await m.orden(19, [principales]);
    const leidos = niveles(principales, actuales, principal);
    cambio = cambio.map(x => x.divisa === principal ? leidos.find(y => y.valor === x.valor) : x);
  }
  const [cc, vc, nc] = await m.orden(17);
  return { divisa: principal, cambio, recaudacion: niveles(vc, nc, cc || principal) };
}
export async function herramienta(m, op, avisar) {
  const h = op.herramienta;
  if (!h) throw new Error('Falta la herramienta');
  if (h.accion === 'diagnostico') return avisar('cobrada', null, await diagnostico(m));
  if (h.accion === 'niveles') return avisar('cobrada', null, await inventario(m));
  if (h.accion === 'inhibiciones') {
    const [monedas, billetes] = await m.orden(78, ['EUR']);
    const valores = [monedas, billetes].filter(Boolean).join(',').split(',').map(x => entero(x));
    if (!valores.length || valores.some(x => !EURO.includes(x)) || new Set(valores).size !== valores.length) throw new Error('Denominaciones reconocidas no válidas');
    const [s] = await m.orden(21, ['EUR', valores.join(',')]);
    const estados = s.split(',');
    if (estados.length !== valores.length) throw new Error('Configuración de denominaciones incompleta');
    return avisar('cobrada', null, { denominaciones: valores.map((valor, i) => ({ valor, estado: entero(estados[i], 2) })), divisa: 'EUR' });
  }
  if (h.confirmado !== true) throw new Error('Falta confirmar la operación sensible');
  if (h.accion === 'conectar') {
    m.pausada = false; await m.asegurar(); await reposoSeguro(m); m.mantenerViva();
    return avisar('cobrada', null, { estado: 1 });
  }
  await reposoSeguro(m);
  if (h.accion === 'desconectar') {
    m.pausada = true;
    await m.orden(7); // CloseAll cierra dispositivos, conserva servicio para la próxima conexión (§8.2.3).
    const [estado] = await m.orden(40);
    if (entero(estado, 7) !== 0) throw new Error('No se confirmó ALL_CLOSED');
    m.soltar(); return avisar('cobrada', null, { estado: 0 });
  }
  if (h.accion === 'configurar') {
    const lista = seleccion(h.denominaciones, 'estado');
    await m.orden(36, ['EUR', lista.map(x => x.valor).join(','), lista.map(x => x.estado).join(',')]);
    const [s] = await m.orden(21, ['EUR', lista.map(x => x.valor).join(',')]);
    if (s !== lista.map(x => x.estado).join(',')) throw new Error('La lectura no coincide con la configuración solicitada');
    return avisar('cobrada', null, { denominaciones: lista, divisa: 'EUR' });
  }
  const antes = await inventario(m);
  if ([...antes.cambio, ...antes.recaudacion].some(x => x.divisa !== 'EUR')) throw new Error('Vaciado multidivisa pendiente de validación; no se ha enviado');
  let lista;
  if (h.accion === 'cierre') lista = seleccion(h.conservar);
  else if (h.accion !== 'recicladores' || !['monedas', 'billetes', 'todo'].includes(h.dispositivo)) throw new Error('Herramienta no válida');
  let transferido = 0;
  const alTransferir = p => { transferido = entero(p[0]); };
  m.on('109', alTransferir); // ValueToCashBox
  try {
    const fin = await hastaDisabled(m, () => h.accion === 'cierre'
      ? m.orden(13, [lista.map(x => x.valor).join(','), lista.map(x => x.unidades).join(',')])
      : m.orden(12, [{ monedas: 1, billetes: 2, todo: 5 }[h.dispositivo]]),
    () => avisar('en_curso', null, { transferido }, { fase: 'vaciando', objetivo: 0, introducido: 0, devuelto: 0 }));
    await comprobarFin(m, fin);
    const [valor] = await m.orden(45); transferido = entero(valor);
    const despues = await inventario(m);
    for (const x of antes.cambio) {
      const elegida = h.accion === 'cierre' || h.dispositivo === 'todo' || (h.dispositivo === 'monedas' ? x.valor < 500 : x.valor >= 500);
      const esperado = !elegida ? x.unidades : h.accion === 'cierre' ? Math.min(x.unidades, lista.find(a => a.valor === x.valor)?.unidades ?? 0) : 0;
      if ((despues.cambio.find(a => a.valor === x.valor && a.divisa === x.divisa)?.unidades ?? 0) !== esperado) throw new Error('Los niveles finales no coinciden. Requiere conciliación.');
    }
    const total = xs => xs.reduce((s, x) => s + x.valor * x.unidades, 0);
    if (total(antes.cambio) - total(despues.cambio) !== transferido || total(despues.recaudacion) - total(antes.recaudacion) !== transferido) throw revision('No cuadra el traslado con la recaudación; requiere revisión');
    return avisar('cobrada', null, { ...despues, transferido, fin, movimiento_interno: true });
  } finally { m.off('109', alTransferir); }
}
