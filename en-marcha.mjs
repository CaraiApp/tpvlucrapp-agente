// Que no se cierre el programa con una operación del cajón a medias (al actualizarlo o desinstalarlo): cerrarlo corta la
// conexión y la máquina se cierra a medio cobro (manual del integrador §8.2.3). El programa en marcha deja una marca
// mientras lleva alguna; el instalador deja la suya, espera a que no quede ninguna y solo entonces lo para. Mientras se
// actualiza, el programa no empieza otra: la rechaza antes de tocar la máquina (sin nada que revisar).
// Cada uno escribe primero su marca y luego mira la del otro: así, al menos uno de los dos ve al otro.
import fs from 'node:fs';
import path from 'node:path';

const CAJON = 'cajon-en-marcha.json';
const ACTUALIZANDO = 'actualizando.json';
/** El programa la renueva cada 10 s: sin renovar en 1 minuto, quien la dejó ya no está. */
const VIGENCIA_CAJON = 60_000;
const VIGENCIA_ACTUALIZANDO = 30 * 60_000;
const dormir = ms => new Promise(r => setTimeout(r, ms));

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function leer(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return null; }
}
function escribir(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const temporal = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(temporal, JSON.stringify(datos));
  fs.renameSync(temporal, archivo);
}
function quitarSiEsMia(archivo) {
  if (leer(archivo)?.pid === process.pid) fs.rmSync(archivo, { force: true });
}
function deOtroVivo(marca, vigencia, ahora) {
  return !!marca && Number.isSafeInteger(marca.pid) && marca.pid !== process.pid && ahora - Date.parse(marca.en) < vigencia && vivo(marca.pid);
}

/** El programa: hay operaciones del cajón en marcha (o ya no). Nunca lanza: una marca que no se escribe no para el cobro. */
export function marcarCajon(carpeta, enMarcha) {
  const archivo = path.join(carpeta, CAJON);
  try {
    if (enMarcha) escribir(archivo, { pid: process.pid, en: new Date().toISOString() });
    else quitarSiEsMia(archivo);
  } catch { /* sin marca, el instalador no esperaría: se intenta de nuevo en la siguiente renovación */ }
}

/** El programa: ¿hay un instalador a punto de cerrarlo? */
export function seEstaActualizando(carpeta, ahora = Date.now()) {
  return deOtroVivo(leer(path.join(carpeta, ACTUALIZANDO)), VIGENCIA_ACTUALIZANDO, ahora);
}

/** El instalador: ¿lleva el programa alguna operación del cajón? */
export function hayCajonEnMarcha(carpeta, ahora = Date.now()) {
  return deOtroVivo(leer(path.join(carpeta, CAJON)), VIGENCIA_CAJON, ahora);
}

/**
 * El instalador: deja su marca (el programa ya no empieza operaciones nuevas) y devuelve cómo quitarla al acabar. Si no se
 * puede escribir, se instala igual: la espera de las operaciones en marcha (`esperarCajonLibre`) sigue valiendo.
 */
export function empezarActualizacion(carpeta) {
  const archivo = path.join(carpeta, ACTUALIZANDO);
  try { escribir(archivo, { pid: process.pid, en: new Date().toISOString() }); } catch { return () => {}; }
  return () => { try { quitarSiEsMia(archivo); } catch { /* caduca sola */ } };
}

/** El instalador: espera a que el programa acabe lo que lleva en el cajón (sin cerrarlo nunca a medias). */
export async function esperarCajonLibre(carpeta, { avisar = () => {}, limite = 25 * 60_000, intervalo = 1000, esperar = dormir } = {}) {
  const hasta = Date.now() + limite;
  for (let avisado = false; hayCajonEnMarcha(carpeta); avisado = true) {
    if (!avisado) avisar();
    if (Date.now() > hasta) throw new Error('El cajón automático sigue con una operación en marcha: termínala y vuelve a abrir el instalador. No se ha cambiado nada.');
    await esperar(intervalo);
  }
}
