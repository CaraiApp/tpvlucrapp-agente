// El programa se actualiza solo (Luis, 5-11: «quiero solucionar el máximo de errores posibles»; el PC de la barra tenía la
// 0.8.10 cuando el servidor ya pedía la 0.8.12). La plataforma dice en cada latido qué versión está publicada; de madrugada,
// sin nada en marcha en el cajón, el programa descarga esa versión de GitHub, comprueba que es ella (la arranca con
// --version) y la deja instalarse con el instalador de siempre (espera a que el cajón esté libre, para el programa viejo,
// lo sustituye y lo vuelve a arrancar; el enlace, la pausa y el diario del CashKeeper se conservan). Nada secreto aquí.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** ¿`a` (x.y.z) es más nueva que `b`? Sin alguna de las dos, no. */
export function esMasNueva(a, b) {
  if (!a || !b || !/^\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+$/.test(b)) return false;
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * ¿Toca actualizar ahora? Solo de madrugada (entre las 4 y las 7, hora del ordenador: el local ya ha cerrado y aún no ha
 * abierto), con una versión publicada más nueva que la que corre, sin operación del cajón en marcha y sin haberlo intentado
 * ya hoy con esa misma versión (un fallo no se repite cada diez minutos: a la noche siguiente).
 */
export function tocaActualizar({ actual, publicada, ahora = new Date(), cajonEnMarcha = false, ultimoIntento = null, desde = 4, hasta = 7 }) {
  if (!esMasNueva(publicada, actual) || cajonEnMarcha) return false;
  const hora = ahora.getHours();
  if (hora < desde || hora >= hasta) return false;
  if (ultimoIntento?.version === publicada && ahora.getTime() - Date.parse(ultimoIntento.en) < 20 * 60 * 60_000) return false;
  return true;
}

/** Descarga a un archivo (siguiendo redirecciones), sin dejar medias descargas con el nombre final. */
export async function descargar(url, destino, { fetchImpl = fetch, maximo = 200 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const respuesta = await fetchImpl(url, { redirect: 'follow' });
  if (!respuesta.ok) throw new Error(`No se pudo descargar (${respuesta.status})`);
  const datos = Buffer.from(await respuesta.arrayBuffer());
  if (!datos.length || datos.length > maximo) throw new Error('La descarga está vacía o es demasiado grande');
  const temporal = `${destino}.${process.pid}.parte`;
  fs.writeFileSync(temporal, datos, { mode: 0o755 });
  fs.renameSync(temporal, destino);
  return datos.length;
}

/** El programa descargado dice su versión con --version: tiene que ser la esperada (si no, no se instala). */
export async function comprobarVersion(programa, esperada, { ejecutar = spawn, plazo = 30_000 } = {}) {
  const hijo = ejecutar(programa, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let salida = '';
  hijo.stdout?.on('data', x => { salida += x; });
  const tiempo = setTimeout(() => hijo.kill(), plazo);
  try { await once(hijo, 'exit'); } finally { clearTimeout(tiempo); }
  if (salida.trim() !== esperada) throw new Error(`El programa descargado dice «${salida.trim().slice(0, 40) || 'nada'}» y se esperaba la ${esperada}`);
}

/**
 * Descargar, comprobar y lanzar el instalador. Devuelve qué pasó (para el registro). `lanzar` arranca el instalador aparte
 * (con --instalar: él espera a que el cajón esté libre y para este programa).
 */
export async function actualizar({ version, url, carpeta, log = () => {}, fetchImpl, ejecutar, lanzar }) {
  const destino = path.join(carpeta, `tpvlucrapp-agente-${version}${process.platform === 'win32' ? '.exe' : ''}`);
  log(`Actualización: descargando la ${version}…`);
  const bytes = await descargar(url, destino, { fetchImpl });
  log(`Actualización: descargada (${Math.round(bytes / 1024 / 1024)} MB); comprobando…`);
  await comprobarVersion(destino, version, ejecutar ? { ejecutar } : {});
  log(`Actualización: la ${version} se instala ahora (el instalador espera a que el cajón esté libre y reinicia el programa)`);
  await lanzar(destino);
  return destino;
}

/** Al arrancar: las descargas de otras versiones sobran (la que corre ya es la buena, o la próxima noche se baja otra vez). */
export function limpiarDescargas(carpeta, versionActual) {
  try {
    for (const f of fs.readdirSync(carpeta)) {
      if (/^tpvlucrapp-agente-\d+\.\d+\.\d+/.test(f) && !f.includes(`-${versionActual}`)) fs.rmSync(path.join(carpeta, f), { force: true });
    }
  } catch { /* sin carpeta, nada que limpiar */ }
}

/** Dónde se apunta el último intento (versión y hora), para no insistir cada diez minutos. */
export function leerIntento(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return null; }
}
export function guardarIntento(archivo, version, resultado) {
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify({ version, en: new Date().toISOString(), resultado }));
  } catch { /* sin marca, como mucho se intenta otra vez */ }
}
