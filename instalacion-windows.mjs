import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const literal = texto => `'${texto.replace(/'/g, "''")}'`;
const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
const ps = (ejecutar, codigo) => ejecutar('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(codigo, 'utf16le').toString('base64')]);

/** Solo cierra el ejecutable instalado; no otros programas ni copias descargadas. */
export async function detenerEjecutableWindows(ejecutar, destino, propioPid = process.pid) {
  await ps(ejecutar, `$ErrorActionPreference='Stop'
    foreach ($procesoTpv in @(Get-Process -Name ${literal(path.win32.basename(destino, '.exe'))} -ErrorAction SilentlyContinue)) {
      if ($procesoTpv.Id -eq ${Number(propioPid)}) { continue }
      if (-not $procesoTpv.Path) { throw 'No se pudo identificar el proceso del programa instalado.' }
      if ($procesoTpv.Path -ieq ${literal(destino)}) {
        Stop-Process -InputObject $procesoTpv -Force -ErrorAction Stop
        if (-not $procesoTpv.WaitForExit(15000)) { throw 'El programa anterior no ha terminado.' }
      }
    }`);
}

/** Reintenta únicamente bloqueos transitorios; rename conserva el binario anterior si falla. */
export async function sustituirPreparado(origen, destino, { renombrar = fs.renameSync, dormir = esperar, intentos = 30 } = {}) {
  for (let i = 0; i < intentos; i++) {
    try { renombrar(origen, destino); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (i === intentos - 1) throw new Error('Windows sigue bloqueando el programa anterior. Cierra otras ventanas de instalación y vuelve a intentarlo. Si persiste, reinicia Windows y abre este instalador. Se conservan la conexión y el registro de CashKeeper.', { cause: error });
      await dormir(500);
    }
  }
}

/** Prepara la copia antes de parar; evita el rearranque durante la sustitución y restaura la tarea si falla. */
export async function actualizarWindows({ origen, destino, nombreTarea, ejecutar, parar, registrar, sustituir = sustituirPreparado }) {
  const carpeta = path.dirname(destino);
  fs.mkdirSync(carpeta, { recursive: true });
  const candado = path.join(carpeta, 'actualizacion.lock');
  let fd;
  try { fd = fs.openSync(candado, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const anterior = Number(fs.readFileSync(candado, 'utf8'));
    if (!Number.isSafeInteger(anterior) || anterior <= 0) throw new Error('Hay una actualización pendiente. Cierra los instaladores abiertos y revisa el archivo actualizacion.lock antes de continuar.');
    try { process.kill(anterior, 0); }
    catch (e) {
      if (e.code !== 'ESRCH') throw e;
      fs.unlinkSync(candado); fd = fs.openSync(candado, 'wx');
    }
    if (fd === undefined) throw new Error('Ya hay otra instalación en curso. Espera a que termine y cierra esa ventana.');
  }
  let preparada; let tarea; let pausada = false;
  try {
    fs.writeFileSync(fd, String(process.pid));
    if (path.resolve(origen).toLowerCase() !== path.resolve(destino).toLowerCase()) {
      preparada = path.join(carpeta, `tpvlucrapp-nuevo-${randomUUID()}.exe`);
      fs.copyFileSync(origen, preparada, fs.constants.COPYFILE_EXCL);
    }
    tarea = JSON.parse(await ps(ejecutar, `$ErrorActionPreference='Stop'
      $tareaTpv = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -eq ${literal(nombreTarea)} }
      if ($tareaTpv) { @{ existe=$true; habilitada=[bool]$tareaTpv.Settings.Enabled; activa=($tareaTpv.State -eq 'Running') } | ConvertTo-Json -Compress }
      else { @{ existe=$false } | ConvertTo-Json -Compress }`));
    if (tarea.existe) {
      await ejecutar('schtasks', ['/Change', '/TN', nombreTarea, '/Disable']);
      pausada = true;
    }
    await parar();
    if (preparada) await sustituir(preparada, destino);
    await registrar();
    await ejecutar('schtasks', ['/Run', '/TN', nombreTarea]);
  } catch (error) {
    if (pausada) {
      try {
        await ejecutar('schtasks', ['/Change', '/TN', nombreTarea, tarea.habilitada ? '/Enable' : '/Disable']);
        if (tarea.habilitada && tarea.activa) await ejecutar('schtasks', ['/Run', '/TN', nombreTarea]);
      } catch { error.message += ' No se pudo restaurar el arranque: vuelve a abrir el instalador antes de trabajar.'; }
    }
    throw error;
  } finally {
    // No se borra ni se reescribe ProgramData: enlace, pausa y diario monetario se conservan.
    if (preparada) { try { fs.rmSync(preparada, { force: true }); } catch { /* Una copia temporal bloqueada no sustituye el error original. */ } }
    fs.closeSync(fd); fs.unlinkSync(candado);
  }
}
