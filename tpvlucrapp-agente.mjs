#!/usr/bin/env node
// =====================================================================================
// TPV Lucrapp · Agente de impresión (versión 0.4.0)
//
// Se instala UNA vez en un ordenador del local y se queda funcionando en segundo plano, sin ventanas: arranca solo cada
// vez que se enciende el ordenador. Imprime lo que la caja deja en la cola (comandas, tickets, informes de cierre,
// apertura del cajón y pruebas):
//   · en las impresoras instaladas en el ordenador (USB, red… las que ve Windows o Mac), por su propia cola de impresión;
//   · o en impresoras de red por IP (ESC/POS, puerto 9100).
// Y le cuenta a la oficina qué impresoras tiene el ordenador, para darlas de alta con un toque.
// Desde la 0.4.0 también lleva los cobros al cajón automático (CashKeeper): se los pasa a CKMonitor por CKFast y le
// cuenta a la caja cómo van (cobrado, cancelado o el motivo si falla). Desde la 0.6.0, también sin CKMonitor: habla
// directamente con la máquina (conexión de control) y la caja enseña en vivo lo que se mete y la vuelta. Desde la 0.6.1,
// sin CKMonitor, también vacía el cajón de recaudación y cambia efectivo (la caja elige con qué billetes y monedas). Desde
// la 0.6.2, vacía el cajón de recaudación de monedas, el de billetes o los dos (el que elija la caja).
//
// Instalar: en la oficina → Impresión y pantallas → «Conectar un ordenador»: descarga el programa, ábrelo y escribe el
// código que sale en la oficina. En Windows pide permiso de administrador una vez (para arrancar solo con el ordenador).
//
//   tpvlucrapp-agente                                   instalar o ver el estado (con doble clic)
//   tpvlucrapp-agente --impresoras                      las impresoras que ve este ordenador
//   tpvlucrapp-agente --probar 192.168.1.50:9100        prueba en una impresora de red
//   tpvlucrapp-agente --probar-impresora "EPSON TM-T20" prueba en una impresora del ordenador
//   tpvlucrapp-agente --probar-cashkeeper 127.0.0.1:16501   comprueba que CKMonitor contesta (CKFast)
//   tpvlucrapp-agente --leer-cashkeeper 192.168.1.20 [CLAVE]  lee el efectivo de la máquina (conexión de consulta)
//   tpvlucrapp-agente --probar-directo 192.168.1.20 [CLAVE]   entra en la máquina sin CKMonitor (CKMonitor cerrado)
//   tpvlucrapp-agente --desinstalar                     quitarlo de este ordenador
//   (--servicio: lo usa el arranque automático · --enlazar CÓDIGO y --instalar: instalación sin preguntas)
// Con Node.js 18+ también vale (node tpvlucrapp-agente.mjs), pero entonces no arranca solo: se queda en la ventana.
// =====================================================================================
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { operarCkfast } from './cashkeeper-ckfast.mjs';
import { actualizarWindows, detenerEjecutableWindows } from './instalacion-windows.mjs';
import { marcarCajon, seEstaActualizando, empezarActualizacion, esperarCajonLibre } from './en-marcha.mjs';
import { recuperarInterrupciones } from './cashkeeper-recuperacion.mjs';
import { operarEnMaquina } from './cashkeeper-operaciones.mjs';
import { DiarioCashKeeper, herramienta, esConsultaHerramienta, reposoSeguro, recuperarCancelacionesVacias, recuperarMantenimientosRevisados, inventario, niveles, entero } from './cashkeeper-seguro.mjs';
const VERSION = "0.8.6";
const API_POR_DEFECTO = "https://tpvlucrapp-backend-production.up.railway.app";
const NOMBRE_TAREA = "TPV Lucrapp Agente";
const ETIQUETA_MAC = "com.tpvlucrapp.agente";
const SISTEMA = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";

// Empaquetado como programa (Windows .exe o Mac): process.execPath es el propio programa; con Node, el script.
const ejecutable = path.basename(process.execPath ?? "").toLowerCase();
const esPrograma = ejecutable !== "" && !/^(node|bun)(\.exe)?$/.test(ejecutable);
const carpetaPrograma = esPrograma ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));

/** Configuración (el token) y registro: en una carpeta del sistema, no al lado del programa (TPV_AGENTE_DATOS: pruebas). */
const DATOS = process.env.TPV_AGENTE_DATOS ||
  (SISTEMA === "windows"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "TPV Lucrapp")
    : SISTEMA === "mac"
      ? path.join(os.homedir(), "Library", "Application Support", "TPV Lucrapp")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tpvlucrapp"));
const CONFIGURACION = path.join(DATOS, "agente.json");
const REGISTRO = path.join(DATOS, "agente.log");
const diarioCajon = new DiarioCashKeeper(path.join(DATOS, "cashkeeper-operaciones"));
const conexionesCajon = new DiarioCashKeeper(path.join(DATOS, "cashkeeper-conexiones"));
/** Dónde queda el programa instalado (lo arranca el sistema). */
const INSTALADO =
  SISTEMA === "windows" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "TPV Lucrapp", "tpvlucrapp-agente.exe") : path.join(DATOS, "tpvlucrapp-agente");

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
const hora = () => new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Registro: en pantalla si hay alguien mirando; en segundo plano, a un archivo (que se rota al pasar de 1 MB).
let enSegundoPlano = false;
function log(...partes) {
  if (!enSegundoPlano) {
    console.log(hora(), ...partes);
    return;
  }
  try {
    fs.mkdirSync(DATOS, { recursive: true });
    try {
      if (fs.statSync(REGISTRO).size > 1_000_000) fs.renameSync(REGISTRO, `${REGISTRO}.1`);
    } catch {
      // aún no hay registro
    }
    fs.appendFileSync(REGISTRO, `${new Date().toISOString()} ${partes.join(" ")}\n`);
  } catch {
    // sin registro: no es motivo para dejar de imprimir
  }
}

function preguntar(texto) {
  const consola = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolver) => consola.question(texto, (respuesta) => { consola.close(); resolver(respuesta.trim()); }));
}

/** Si se abrió con doble clic, que la ventana no se cierre antes de leer el mensaje. */
async function salir(codigo, mensaje) {
  if (mensaje) (codigo === 0 ? console.log : console.error)(mensaje);
  if (esPrograma && process.stdin.isTTY) await preguntar("\nPulsa Enter para cerrar.");
  process.exit(codigo);
}

/** Ejecuta un programa del sistema y devuelve lo que escribe (sin ventanas; con tiempo máximo). */
function ejecutar(programa, argumentos, opciones = {}) {
  return new Promise((resolver, rechazar) => {
    execFile(programa, argumentos, { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", ...opciones }, (error, salida, errores) => {
      if (error) rechazar(new Error(String(errores || error.message || "").trim().slice(0, 300) || `${programa} falló`));
      else resolver(salida);
    });
  });
}

// Configuración -------------------------------------------------------------------------------------------------------

function leerConfiguracion() {
  // La 0.2.0 la guardaba al lado del programa: se sigue leyendo (su token vale).
  for (const archivo of [CONFIGURACION, path.join(carpetaPrograma, "agente.json")]) {
    try {
      return JSON.parse(fs.readFileSync(archivo, "utf8"));
    } catch {
      // siguiente
    }
  }
  return {};
}

function guardarConfiguracion(datos) {
  fs.mkdirSync(DATOS, { recursive: true });
  fs.writeFileSync(CONFIGURACION, JSON.stringify(datos, null, 2));
}

const apiDe = (configuracion) => String(process.env.TPV_API ?? configuracion.api ?? API_POR_DEFECTO).replace(/\/$/, "");

// Las impresoras del ordenador --------------------------------------------------------------------------------------

// Las que nunca son de tickets: PDF, XPS, OneNote, fax…
const VIRTUALES = /(print to pdf|xps document writer|onenote|fax|adobe pdf|pdfcreator|microsoft print)/i;
const PUERTOS_VIRTUALES = /^(portprompt:|nul:|shrfax:|file:)/i;

/** Las impresoras instaladas en este ordenador: [{ nombre, driver, puerto, predeterminada, estado }]. */
async function detectarImpresoras() {
  if (SISTEMA === "windows") {
    const salida = await ejecutar("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | Select-Object Name, DriverName, PortName, Default, WorkOffline, PrinterStatus | ConvertTo-Json -Compress",
    ]);
    const datos = salida.trim() ? JSON.parse(salida) : [];
    return (Array.isArray(datos) ? datos : [datos])
      .filter((i) => i?.Name && !VIRTUALES.test(i.Name) && !PUERTOS_VIRTUALES.test(i.PortName ?? ""))
      .map((i) => ({
        nombre: String(i.Name).slice(0, 200),
        driver: i.DriverName ? String(i.DriverName).slice(0, 200) : null,
        puerto: i.PortName ? String(i.PortName).slice(0, 200) : null,
        predeterminada: Boolean(i.Default),
        estado: i.WorkOffline || i.PrinterStatus === 7 ? "sin conexión" : i.PrinterStatus === 6 ? "detenida" : "lista",
      }));
  }
  // Mac y Linux: CUPS (en inglés, para leerlo igual en cualquier idioma).
  const ingles = { env: { ...process.env, LANG: "C", LC_ALL: "C" } };
  const nombres = (await ejecutar("lpstat", ["-e"], ingles).catch(() => "")).split("\n").map((n) => n.trim()).filter(Boolean);
  const predeterminada = (await ejecutar("lpstat", ["-d"], ingles).catch(() => "")).match(/:\s*(\S+)\s*$/m)?.[1] ?? null;
  const estados = await ejecutar("lpstat", ["-p"], ingles).catch(() => "");
  return nombres
    .filter((nombre) => !VIRTUALES.test(nombre))
    .map((nombre) => {
      const linea = estados.split("\n").find((l) => l.startsWith(`printer ${nombre} `)) ?? "";
      return { nombre: nombre.slice(0, 200), driver: null, puerto: null, predeterminada: nombre === predeterminada, estado: /disabled/i.test(linea) ? "detenida" : "lista" };
    });
}

// Imprimir ------------------------------------------------------------------------------------------------------------

/** Manda bytes a una impresora de red (puerto 9100) y espera a que cierre la conexión. */
function imprimirEnRed(direccion, puerto, datos) {
  return new Promise((resolver, rechazar) => {
    if (!direccion) return rechazar(new Error("la impresora no tiene dirección"));
    const conexion = net.createConnection({ host: direccion, port: Number(puerto) || 9100 });
    const tiempo = setTimeout(() => {
      conexion.destroy();
      rechazar(new Error(`no responde en ${direccion}:${puerto}`));
    }, 10_000);
    conexion.on("connect", () => conexion.end(datos));
    conexion.on("close", () => {
      clearTimeout(tiempo);
      resolver();
    });
    conexion.on("error", (error) => {
      clearTimeout(tiempo);
      rechazar(error);
    });
  });
}

// Windows: un ayudante pequeño (C#, se compila con lo que ya trae Windows) manda los bytes tal cual («RAW») a la cola de
// la impresora. Se prepara al instalar; si faltara, la primera vez que imprime.
const AYUDANTE_CS = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class ImprimirTalCual {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern bool OpenPrinter(string nombre, out IntPtr impresora, IntPtr defecto);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool ClosePrinter(IntPtr impresora);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int StartDocPrinter(IntPtr impresora, int nivel, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo documento);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool EndDocPrinter(IntPtr impresora);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool StartPagePrinter(IntPtr impresora);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool EndPagePrinter(IntPtr impresora);
  [DllImport("winspool.drv", SetLastError = true, ExactSpelling = true)]
  static extern bool WritePrinter(IntPtr impresora, byte[] datos, int cuantos, out int escritos);

  public static int Main(string[] argumentos) {
    if (argumentos.Length < 2) { Console.Error.WriteLine("uso: rawprint \"impresora\" archivo [titulo]"); return 2; }
    byte[] datos = File.ReadAllBytes(argumentos[1]);
    IntPtr impresora;
    if (!OpenPrinter(argumentos[0], out impresora, IntPtr.Zero)) {
      Console.Error.WriteLine("No se encuentra la impresora «" + argumentos[0] + "» (error " + Marshal.GetLastWin32Error() + ")");
      return 3;
    }
    try {
      DocInfo documento = new DocInfo();
      documento.pDocName = argumentos.Length > 2 ? argumentos[2] : "TPV Lucrapp";
      documento.pDataType = "RAW";
      int trabajo = StartDocPrinter(impresora, 1, documento);
      if (trabajo == 0) {
        documento.pDataType = "XPS_PASS"; // controladores v4 de Windows
        trabajo = StartDocPrinter(impresora, 1, documento);
      }
      if (trabajo == 0) { Console.Error.WriteLine("La impresora no acepta el trabajo (error " + Marshal.GetLastWin32Error() + ")"); return 4; }
      try {
        StartPagePrinter(impresora);
        int escritos;
        bool bien = WritePrinter(impresora, datos, datos.Length, out escritos);
        EndPagePrinter(impresora);
        if (!bien || escritos != datos.Length) { Console.Error.WriteLine("La impresora no aceptó los datos (error " + Marshal.GetLastWin32Error() + ")"); return 5; }
      } finally {
        EndDocPrinter(impresora);
      }
    } finally {
      ClosePrinter(impresora);
    }
    return 0;
  }
}
`;

async function compilarAyudante(destino) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const fuente = path.join(os.tmpdir(), `tpvlucrapp-rawprint-${process.pid}.cs`);
  fs.writeFileSync(fuente, AYUDANTE_CS);
  const comillas = (texto) => `'${texto.replace(/'/g, "''")}'`;
  try {
    await ejecutar(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$codigo = Get-Content -Raw -LiteralPath ${comillas(fuente)}; Add-Type -TypeDefinition $codigo -Language CSharp -OutputAssembly ${comillas(destino)} -OutputType ConsoleApplication`,
      ],
      { timeout: 120_000 },
    );
  } finally {
    try {
      fs.unlinkSync(fuente);
    } catch {
      // ya no estaba
    }
  }
  if (!fs.existsSync(destino)) throw new Error("no se pudo preparar la impresión de Windows");
  return destino;
}

async function ayudanteWindows() {
  for (const candidato of [path.join(path.dirname(INSTALADO), "rawprint.exe"), path.join(DATOS, "rawprint.exe")]) {
    if (fs.existsSync(candidato)) return candidato;
  }
  return compilarAyudante(path.join(DATOS, "rawprint.exe"));
}

/** Manda bytes tal cual a una impresora instalada en el ordenador (Windows: cola «RAW»; Mac/Linux: lp -o raw). */
async function imprimirEnSistema(nombre, datos, titulo = "TPV Lucrapp") {
  if (!nombre) throw new Error("falta el nombre de la impresora en el ordenador");
  const archivo = path.join(os.tmpdir(), `tpvlucrapp-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(archivo, datos);
  try {
    if (SISTEMA === "windows") await ejecutar(await ayudanteWindows(), [nombre, archivo, titulo.slice(0, 60)], { timeout: 60_000 });
    else await ejecutar("lp", ["-d", nombre, "-o", "raw", "-t", titulo.slice(0, 60), archivo], { timeout: 60_000 });
  } catch (error) {
    // CUPS dice «No such file or directory» cuando la impresora no existe: mejor decirlo claro.
    const instaladas = await detectarImpresoras().catch(() => null);
    if (instaladas && !instaladas.some((i) => i.nombre === nombre)) throw new Error(`«${nombre}» no está instalada en este ordenador`);
    throw error;
  } finally {
    try {
      fs.unlinkSync(archivo);
    } catch {
      // ya no estaba
    }
  }
}

/** Una página de prueba mínima en ESC/POS: inicializar, texto, avance y corte. */
function paginaDePrueba(donde) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40, 0x1b, 0x61, 1, 0x1b, 0x45, 1]),
    Buffer.from("TPV LUCRAPP\n", "latin1"),
    Buffer.from([0x1b, 0x45, 0]),
    Buffer.from(`Prueba directa del agente ${VERSION}\n${donde}\n${new Date().toLocaleString("es-ES")}\n\n\n`, "latin1"),
    Buffer.from([0x1d, 0x56, 66, 0]),
  ]);
}

// Arranque automático -------------------------------------------------------------------------------------------------

const xmlSeguro = (texto) => texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function esAdministrador() {
  try {
    execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Windows: vuelve a abrir el programa con permiso de administrador (sale el aviso de Windows: «¿Permitir…?»). */
function abrirComoAdministrador(argumentos) {
  const comillas = (texto) => `'${texto.replace(/'/g, "''")}'`;
  const lista = argumentos.length > 0 ? ` -ArgumentList ${argumentos.map(comillas).join(",")}` : "";
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath ${comillas(process.execPath)}${lista} -Verb RunAs`], {
    stdio: "ignore",
    windowsHide: true,
  });
}

// Tarea de Windows: al encender el ordenador, como «SYSTEM» (sin ventana ni sesión iniciada); si se cae, vuelve a
// arrancar al minuto; sin límite de tiempo y aunque vaya con batería.
function tareaWindows(programa) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>TPV Lucrapp: imprime las comandas y los tickets en las impresoras del local.</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
  <Principals><Principal id="Sistema"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Sistema"><Exec><Command>"${xmlSeguro(programa)}"</Command><Arguments>--servicio</Arguments></Exec></Actions>
</Task>
`;
}

function plistMac(programa) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ETIQUETA_MAC}</string>
  <key>ProgramArguments</key><array><string>${xmlSeguro(programa)}</string><string>--servicio</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

const plistRuta = () => path.join(os.homedir(), "Library", "LaunchAgents", `${ETIQUETA_MAC}.plist`);

async function pararEnSegundoPlano() {
  if (SISTEMA === "windows") {
    await ejecutar("schtasks", ["/End", "/TN", NOMBRE_TAREA]).catch(() => {});
    await detenerEjecutableWindows(ejecutar, INSTALADO);
  } else if (SISTEMA === "mac") {
    await ejecutar("launchctl", ["bootout", `gui/${process.getuid()}/${ETIQUETA_MAC}`]).catch(() => {});
  }
}

/**
 * Antes de parar el programa (al actualizarlo o desinstalarlo): que acabe lo que lleve en el cajón automático. Cerrarlo a
 * medias corta la conexión y la máquina se cierra a medio cobro; mientras, no empieza ninguna operación nueva.
 */
async function sinCajonAMedias(trabajo) {
  const terminar = empezarActualizacion(DATOS);
  try {
    await esperarCajonLibre(DATOS, { avisar: () => console.log("El cajón automático está haciendo una operación en este ordenador: se espera a que acabe (no cierres esta ventana)…") });
    return await trabajo();
  } finally {
    terminar();
  }
}

/** Copia el programa a su sitio y lo deja arrancando solo con el ordenador (y en marcha ya). */
function instalar() {
  return sinCajonAMedias(instalarYa);
}

async function instalarYa() {
  if (SISTEMA === "windows") {
    return actualizarWindows({ origen: process.execPath, destino: INSTALADO, nombreTarea: NOMBRE_TAREA, ejecutar, parar: pararEnSegundoPlano, registrar: async () => {
      try {
        await compilarAyudante(path.join(path.dirname(INSTALADO), "rawprint.exe"));
      } catch (error) {
        log(`Aviso: la impresión por las impresoras de Windows se preparará al imprimir (${error.message})`);
      }
      const xml = path.join(os.tmpdir(), `tpvlucrapp-tarea-${process.pid}.xml`);
      fs.writeFileSync(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(tareaWindows(INSTALADO), "utf16le")]));
      try {
        await ejecutar("schtasks", ["/Create", "/TN", NOMBRE_TAREA, "/XML", xml, "/F"]);
      } finally {
        fs.unlinkSync(xml);
      }
    } });
  }
  await pararEnSegundoPlano();
  fs.mkdirSync(path.dirname(INSTALADO), { recursive: true });
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(INSTALADO).toLowerCase()) fs.copyFileSync(process.execPath, INSTALADO);
  if (SISTEMA === "mac") {
    fs.chmodSync(INSTALADO, 0o755);
    await ejecutar("xattr", ["-d", "com.apple.quarantine", INSTALADO]).catch(() => {});
    fs.mkdirSync(path.dirname(plistRuta()), { recursive: true });
    fs.writeFileSync(plistRuta(), plistMac(INSTALADO));
    await ejecutar("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistRuta()]);
  }
}

function desinstalar() {
  return sinCajonAMedias(desinstalarYa);
}

async function desinstalarYa() {
  await pararEnSegundoPlano();
  if (SISTEMA === "windows") {
    await ejecutar("schtasks", ["/Delete", "/TN", NOMBRE_TAREA, "/F"]).catch(() => {});
    fs.rmSync(path.dirname(INSTALADO), { recursive: true, force: true });
  } else if (SISTEMA === "mac") {
    fs.rmSync(plistRuta(), { force: true });
  }
  fs.rmSync(DATOS, { recursive: true, force: true });
}

// Cajón automático (CashKeeper) ---------------------------------------------------------------------------------------
// CKFast (manual del integrador de CashKeeper, §3): un socket a CKMonitor (puerto 16501 de serie), texto ASCII sin fin de
// línea y una respuesta corta; una conexión por orden (las largas se cortan). «C|tiquet|importe|…» crea el cobro (con el
// importe en negativo, una devolución) y «S|tiquet» dice cómo va: OK|Pending, OK|OK (cobrado), OK|Cancel o NOK|Not found.
// La pantalla del cobro (meter el dinero, la vuelta) es la de CKMonitor. La orden «C» ya viene hecha de la plataforma.

/** Manda una orden a CKMonitor y devuelve su respuesta («OK|…» o «NOK|…»), sin espacios ni saltos. */
function ordenCkfast(host, puerto, orden, espera = 8000) {
  return new Promise((resolver, rechazar) => {
    const conexion = net.createConnection({ host, port: Number(puerto) || 16501 });
    let respuesta = "";
    let terminado = false;
    const acabar = (error) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(tiempo);
      conexion.destroy();
      if (error) rechazar(error);
      else resolver(respuesta.replace(/[\0\r\n]+/g, "").trim());
    };
    const tiempo = setTimeout(() => acabar(respuesta ? null : new Error(`CKMonitor no contesta en ${host}:${puerto}`)), espera);
    conexion.setEncoding("utf8");
    conexion.on("connect", () => conexion.write(Buffer.from(orden, "ascii")));
    conexion.on("data", (trozo) => {
      respuesta += trozo;
      // La respuesta es corta y llega de una vez: se da un respiro por si llega en dos trozos.
      if (/^N?OK\|/.test(respuesta.trim())) setTimeout(() => acabar(null), 60);
    });
    // Cerrar sin contestar no es una respuesta: es un corte (se reintenta o se sigue esperando).
    conexion.on("end", () => acabar(respuesta.trim() ? null : new Error("CKMonitor cerró la conexión sin contestar")));
    conexion.on("error", (error) => acabar(error));
  });
}

/** Lo que significa cada «no» de CKMonitor, para la caja. */
function explicarCkfast(respuesta) {
  const textos = {
    "NOK|Invalid ID": "CKMonitor no acepta el número del cobro",
    "NOK|Failed": "CKMonitor no ha podido añadir el cobro a su cola",
    "NOK|Unknown command": "CKMonitor no entiende la orden: ¿está activado CKFast en su configuración?",
    "NOK|Not found": "CKMonitor ya no tiene este cobro (¿se reinició?): revisa en su registro si se cobró",
  };
  return textos[respuesta] ?? `CKMonitor ha contestado «${respuesta || "nada"}»`;
}

const euros = (centimos) => `${(centimos / 100).toFixed(2).replace(".", ",")} €`;

// Leer el efectivo (desde la 0.5.0) -------------------------------------------------------------------------------------
// Por la conexión de solo consulta del CashKeeper («Office», puerto 8002; manual del integrador §8): entrar con la clave
// (StartCNT `$47#` → `$57|número#` → `$57|número+clave#` → `$58|versión#`), pedir las unidades de cada moneda y billete
// para dar cambio (79 GetLastLevels; si no la entiende, 19 GetCurrentLevel con las del euro) y las del cajón de
// recaudación (17 GetCashBoxLevel) y cerrar. NUNCA Startup, Terminate ni nada que mueva o cierre la máquina: la tiene
// CKMonitor. Los valores van en céntimos (un billete de 5 € es 500) y solo cuentan los euros (la máquina puede aceptar
// otras divisas).

const totalDe = (lista) => lista.filter(x => !x.divisa || x.divisa === "EUR").reduce((suma, { valor, unidades }) => suma + valor * unidades, 0);

/** Office utiliza el mismo inventario actual que Host, sin Startup ni órdenes que cambien la máquina. */
export function leerEfectivo(host, puerto, semilla, espera = 15000) {
  return new Promise((resolver, rechazar) => {
    const conexion = net.createConnection({ host, port: Number(puerto) || 8002 });
    let buffer = ''; let claveMandada = false; let dentro = false; let acabado = false; let pendiente;
    const acabar = (error, resultado) => {
      if (acabado) return;
      acabado = true; clearTimeout(tiempo); conexion.destroy();
      if (error) { pendiente?.rechazar(error); pendiente = null; rechazar(error); }
      else resolver(resultado);
    };
    const tiempo = setTimeout(() => acabar(new Error(dentro ? 'La máquina no contesta a la consulta de efectivo' : 'No se puede entrar en la consulta de la máquina')), espera);
    const mandar = texto => conexion.write(Buffer.from(texto, 'ascii'));
    const orden = (codigo, parametros = []) => new Promise((resolve, reject) => {
      if (acabado) return reject(new Error('La consulta se ha cerrado'));
      if (pendiente) return reject(new Error('Hay una consulta en curso'));
      if (![17,19,38,78,79].includes(codigo)) return reject(new Error('Orden no permitida en lectura Office'));
      pendiente = { codigo, resolver: resolve, rechazar: reject };
      mandar(`$${codigo}${parametros.length ? '|' + parametros.join('|') : ''}#`);
    });
    conexion.setEncoding('latin1');
    conexion.on('connect', () => mandar('$47#'));
    conexion.on('data', trozo => {
      buffer += trozo;
      if (buffer.length > 262144) return acabar(new Error('Respuesta de inventario demasiado grande'));
      for (let fin = buffer.indexOf('#'); fin >= 0 && !acabado; fin = buffer.indexOf('#')) {
        const texto = buffer.slice(0, fin); buffer = buffer.slice(fin + 1);
        const inicio = texto.indexOf('$'); if (inicio < 0) continue;
        const [c, ...p] = texto.slice(inicio + 1).split('|').map(x => x.trim());
        if (c === '57' && !claveMandada) {
          claveMandada = true; const clave = Number(p[0]) + Number(semilla);
          if (!Number.isSafeInteger(clave)) return acabar(new Error('Clave de consulta no válida'));
          mandar(`$57|${clave}#`);
        } else if (c === '58' && !dentro) {
          dentro = true;
          void inventario({orden}).then(r => acabar(null, r), acabar);
        } else if (pendiente && Number(c) === pendiente.codigo) {
          const peticion = pendiente; pendiente = null;
          if (p[0] === '1') peticion.resolver(p.slice(1));
          else peticion.rechazar(Object.assign(new Error(`No se pudo consultar el efectivo (orden ${c}, error ${p[1]}): ${p[2] ?? ''}`), {codigo:Number(p[1])}));
        }
      }
    });
    conexion.on('end', () => acabar(new Error(dentro ? 'La máquina cortó la consulta' : 'La máquina no acepta la clave de consulta: revísala en la oficina')));
    conexion.on('error', acabar);
    conexion.on('close', () => { if (!acabado) acabar(new Error('Se cerró la consulta de efectivo')); });
  });
}
// Conexión directa con el CashKeeper, sin CKMonitor (desde la 0.6.0) ---------------------------------------------------
// Manual del integrador §7 (CKeeper) y §8 (Raw Sockets), con el anexo 9.2. El programa abre la conexión de control de
// la máquina (Host, puerto 8001), entra con la clave (como la consulta) y la arranca (39 Startup). La conexión se queda
// abierta todo el día: si se corta, la máquina se cierra sola y hay que arrancarla otra vez; si se cortó a medio cobro, al
// arrancar lo avisa (104 ProcessInterrupted) y se bloquean movimientos hasta revisión. Una orden cada vez («$código|parámetros#» →
// «$código|1|…#» o «$código|0|error|texto#»); los avisos de la máquina (códigos de 100 en adelante) llegan cuando
// quieren: 100 Disabled (acabó lo que hacía), 104 ProcessInterrupted, 106 StateChange, 107 ValueIN (lo metido),
// 108 ValueOUT (lo que sale), 110 Warning. Cobrar: 42 Totalize (con la vuelta automática); cancelar: 9 Disable con
// devolución; pagar: 29 Pay; recarga: 67 ActivateRefillMode + 14 Enable. Desconexión explícita: 7 CloseAll
// en reposo y cierre del socket; nunca 48 Terminate. Con esta conexión, CKMonitor tiene que estar cerrado: la máquina tiene un dueño.

const ESTADO_CK = ["cerrada", "en reposo", "esperando el dinero", "pagando", "llevando a recaudación", "vaciando", "en error", "contando el dinero"];

/** Lo normal: la máquina contesta al momento (el ejemplo del SDK de CashKeeper espera 5 s y no cierra nunca la conexión). */
const ESPERA_ORDEN = 10_000;
/**
 * Con una operación en marcha no se suelta nunca la máquina por tardar: si se corta la conexión, se cierra a medio cobro
 * (§8.2.3). Se espera su respuesta hasta 1 minuto; si pasa, no se le manda nada más en esa operación (queda para revisar)
 * y la conexión se reinicia cuando ya ha acabado y está en el diario.
 */
const ATRASO_MAXIMO = 60_000;
/** Desde cuándo la caja avisa de que la máquina está tardando en contestar. */
const AVISO_LENTA = 5_000;

export class MaquinaDirecta extends EventEmitter {
  constructor(host, puerto, semilla) {
    super();
    this.setMaxListeners(50);
    this.host = host;
    this.puerto = Number(puerto) || 8001;
    this.semilla = String(semilla || "100001");
    this.conexion = null;
    this.lista = false;
    this.estado = 0;
    this.pendiente = "";
    this.esperando = null;
    this.negociando = null;
    this.conectando = null;
    this.cola = Promise.resolve();
    this.turno = Promise.resolve();
    this.enCola = 0;
    this.enMarcha = false;
    this.libre = Promise.resolve();
    this.desfasada = false;
    this.raroEnOperacion = false;
    this.esperaOrden = ESPERA_ORDEN; this.atrasoMaximo = ATRASO_MAXIMO; this.avisoLenta = AVISO_LENTA;
    this.interrumpida = null;
    this.mantener = false;
    this.vigilancia = null;
    this.fallos = 0;
    this.pausada = false;
    this.avisos = []; this.nivelesBajos = []; this.billetePendiente = false; this.pregunta = null; this.timerPregunta = null;
  }

  get donde() {
    return `${this.host}:${this.puerto}`;
  }

  /** Con una operación en marcha (de dinero o de ajustes de la máquina) la conexión no se suelta nunca. */
  get ocupada() {
    return this.enMarcha;
  }

  set ocupada(valor) {
    this.enMarcha = valor;
    // Ya acabada (y en el diario): si la máquina se quedó sin contestar, ahora sí se reinicia la conexión.
    if (!valor && (this.desfasada || this.esperando?.atrasada)) this.#reiniciar("no contestó a tiempo durante la operación");
  }

  /** Ni en marcha ni esperando turno: se puede soltar (otra clave, otro ordenador). */
  get libreDeOperaciones() {
    return !this.enMarcha && this.enCola === 0;
  }

  /** La máquina lleva un rato sin contestar a una orden (la caja lo avisa). */
  get tardando() {
    return this.desfasada || (!!this.esperando && Date.now() - this.esperando.enviada >= this.avisoLenta);
  }

  #reiniciar(motivo) {
    log(`CashKeeper (directo) ${this.donde}: se reinicia la conexión (${motivo})`);
    this.conexion?.destroy();
  }

  /** Conectada, con la clave y arrancada (si no lo estaba, lo hace ahora). */
  asegurar() {
    if (this.pausada && !this.lista) return Promise.reject(new Error("CashKeeper desconectado por el encargado: usa Conectar"));
    if (this.lista) return Promise.resolve();
    if (!this.conectando) this.conectando = this.#conectar().finally(() => (this.conectando = null));
    return this.conectando;
  }

  async #conectar() {
    const conexion = net.createConnection({ host: this.host, port: this.puerto });
    conexion.setEncoding("latin1");
    conexion.setNoDelay(true);
    conexion.setKeepAlive(true, 10_000);
    await new Promise((resolver, rechazar) => {
      const tiempo = setTimeout(() => {
        conexion.destroy();
        rechazar(new Error(`La máquina no contesta en ${this.donde}`));
      }, 8000);
      conexion.once("connect", () => {
        clearTimeout(tiempo);
        resolver();
      });
      conexion.once("error", (error) => {
        clearTimeout(tiempo);
        rechazar(new Error(`No se puede conectar con la máquina en ${this.donde}: ${error.message}`));
      });
    });
    this.conexion = conexion;
    if (this.pausada) { conexion.destroy(); throw new Error("CashKeeper desconectado por el encargado"); }
    this.pendiente = "";
    conexion.on("data", (trozo) => { try { this.#recibir(trozo); } catch { this.#raro("un fallo al leer lo que dice"); } });
    conexion.on("close", () => this.#cortada(conexion));
    conexion.on("error", () => {});
    try {
      // La clave: StartCNT → CNT (número) → CNT (número + clave) → CNT_OK. Con la clave mala, la máquina cierra sin más.
      const [numero] = await this.#negociar("$47#", "57");
      const clave = Number(numero) + Number(this.semilla);
      if (!Number.isSafeInteger(clave)) throw new Error("La máquina no ha dado el número para la clave");
      await this.#negociar(`$57|${clave}#`, "58", "La máquina no acepta la clave (de serie 100001): revísala en la oficina");
      // Arrancarla (abre sus dispositivos; si se cortó a medias, avisa con 104 antes de contestar).
      try {
        await this.#enviar(39, [0], 30_000);
      } catch (error) {
        if (error.codigo !== 49) throw error; // 49: ya estaba arrancada
      }
      // Un respiro para los avisos que llegan justo después de arrancar (su estado y, si se cortó a medias, el 104).
      await dormir(300);
      const [estado] = await this.#enviar(40, [], 8000);
      this.estado = entero(estado, 7);
      if (![1, 6].includes(this.estado)) throw new Error("Startup no alcanzó un estado que permita consultar o recuperar");
      this.lista = true;
      this.fallos = 0;
    } catch (error) {
      conexion.destroy();
      throw error;
    }
  }

  #negociar(mensaje, codigo, siSeCierra) {
    return new Promise((resolver, rechazar) => {
      const tiempo = setTimeout(() => {
        this.negociando = null;
        rechazar(new Error(`La máquina no contesta al entrar (${this.donde})`));
      }, 8000);
      this.negociando = {
        codigo,
        siSeCierra,
        resolver: (p) => (clearTimeout(tiempo), resolver(p)),
        rechazar: (e) => (clearTimeout(tiempo), rechazar(e)),
      };
      this.conexion.write(Buffer.from(mensaje, "latin1"));
    });
  }

  /**
   * Una orden de bajo nivel (sin turno): la usan la conexión y `orden`. `paciencia`: lo que espera quien la pide. Sin una
   * operación en marcha, si no contesta, se cierra la conexión y se vuelve a abrir. Con una en marcha (y `tolerante`), no:
   * a quien la pidió se le dice que no contesta (`sinRespuesta`), pero la orden sigue esperando su respuesta, que llegará en
   * orden y se descarta. Hasta entonces no sale otra (`libre`), para no tomar una respuesta atrasada por la de la siguiente.
   */
  #enviar(codigo, parametros, paciencia, tolerante = false) {
    return new Promise((resolver, rechazar) => {
      if (!this.conexion) return rechazar(new Error(`Sin conexión con la máquina en ${this.donde}`));
      this.antesDeEnviar?.(codigo);
      let soltar;
      this.libre = new Promise((r) => (soltar = r));
      let tiempo;
      const acabar = () => (clearTimeout(tiempo), soltar());
      const e = {
        codigo: String(codigo),
        enviada: Date.now(),
        atrasada: false,
        resolver: (p) => {
          acabar();
          if (e.atrasada) log(`CashKeeper (directo) ${this.donde}: la máquina contestó con ${Math.round((Date.now() - e.enviada) / 1000)} s de retraso (orden ${codigo})`);
          resolver(p);
        },
        rechazar: (error) => (acabar(), rechazar(error)),
      };
      const vencer = () => {
        if (this.esperando !== e) return;
        const pasado = Date.now() - e.enviada;
        if (!tolerante || !this.ocupada) {
          // Sin nada en marcha, una conexión que no contesta no es de fiar: se cierra y se vuelve a abrir.
          this.esperando = null;
          e.rechazar(new Error(`La máquina no contesta (orden ${codigo})`));
          this.conexion?.destroy();
          return;
        }
        if (!e.atrasada) {
          e.atrasada = true;
          log(`CashKeeper (directo) ${this.donde}: la máquina tarda en contestar (orden ${codigo}); se espera sin cortar`);
          rechazar(Object.assign(new Error(`La máquina no contesta (orden ${codigo})`), { sinRespuesta: true }));
        }
        if (pasado < this.atrasoMaximo) {
          tiempo = setTimeout(vencer, this.atrasoMaximo - pasado);
          return;
        }
        // Tanto tiempo sin contestar: no se le manda nada más en esta operación (las que esperan turno fallan ya).
        this.desfasada = true;
        log(`✗ CashKeeper (directo) ${this.donde}: la máquina lleva ${Math.round(pasado / 1000)} s sin contestar (orden ${codigo}); no se le manda nada más hasta acabar la operación`);
        soltar();
      };
      tiempo = setTimeout(vencer, paciencia);
      this.esperando = e;
      this.conexion.write(Buffer.from(`$${codigo}${parametros.length ? `|${parametros.join("|")}` : ""}#`, "latin1"));
    });
  }

  /**
   * Una orden a la máquina (de una en una): los datos tras el «1» o un error con el código y el texto de la máquina.
   * `espera`: lo que aguanta quien la pide; sin ella, 10 s, o 1 minuto con una operación en marcha.
   */
  orden(codigo, parametros = [], espera) {
    const turno = this.cola.then(async () => {
      await this.asegurar();
      if (this.desfasada) throw Object.assign(new Error("La máquina dejó de contestar: no se le manda nada más hasta revisarla"), { sinRespuesta: true });
      return this.#enviar(codigo, parametros, espera ?? (this.ocupada ? this.atrasoMaximo : this.esperaOrden), true);
    });
    // La siguiente no sale hasta que esta tenga su respuesta, aunque quien la pidió ya no la espere.
    this.cola = turno.catch(() => {}).then(() => this.libre);
    return turno;
  }

  /** Las operaciones, de una en una: la máquina no puede cobrar y pagar a la vez. */
  enTurno(trabajo) {
    this.enCola++;
    const turno = this.turno.then(trabajo).finally(() => this.enCola--);
    this.turno = turno.catch(() => {});
    return turno;
  }

  #recibir(trozo) {
    this.pendiente += trozo;
    if (this.pendiente.length > 65536) {
      this.pendiente = "";
      return this.#raro("una respuesta demasiado larga");
    }
    for (let fin = this.pendiente.indexOf("#"); fin >= 0; fin = this.pendiente.indexOf("#")) {
      const mensaje = this.pendiente.slice(0, fin);
      this.pendiente = this.pendiente.slice(fin + 1);
      const inicio = mensaje.indexOf("$");
      if (inicio < 0) continue;
      const [codigo, ...p] = mensaje.slice(inicio + 1).split("|").map((x) => x.trim());
      // Un mensaje que no se entiende no tapa los que vienen detrás (el siguiente puede ser el Disabled).
      try {
        this.#mensaje(codigo, p);
      } catch {
        this.#raro(`un mensaje que no se entiende (${String(codigo).slice(0, 6)})`);
      }
    }
  }

  #mensaje(codigo, p) {
    if (this.negociando && codigo === this.negociando.codigo) {
      const n = this.negociando;
      this.negociando = null;
      return n.resolver(p);
    }
    if (Number(codigo) >= 100) return this.#aviso(Number(codigo), p);
    if (this.esperando && codigo === this.esperando.codigo) {
      const e = this.esperando;
      this.esperando = null;
      if (p[0] === "1") e.resolver(p.slice(1));
      else {
        const error = new Error(p[2] ? `${p[2]} (orden ${codigo}, error ${p[1]} de la máquina)` : `La máquina no ha podido hacerlo (orden ${codigo}, error ${p[1] ?? "?"})`);
        error.codigo = Number(p[1]);
        error.rechazoSeguro = (codigo === "29" && [2, 4, 32, 36, 37].includes(error.codigo)) || (codigo === "87" && [2,4,32,34,36,37,38,39,40].includes(error.codigo));
        e.rechazar(error);
      }
    }
    // Otra respuesta suelta (no se esperaba): se ignora.
  }

  /**
   * Algo de la máquina que no se entiende: queda para revisar. Sin nada en marcha, se reinicia la conexión (como siempre);
   * con algo en marcha, nunca (la máquina se cerraría a medias): la operación acaba «para revisar».
   */
  #raro(que) {
    this.eventoInesperado = true;
    if (this.ocupada) this.raroEnOperacion = true;
    log(`✗ CashKeeper (directo) ${this.donde}: ${que}; queda para revisar`);
    if (!this.ocupada) this.conexion?.destroy();
  }

  observaciones() { return { avisos: this.avisos.slice(-20), niveles_bajos: this.nivelesBajos, billete_pendiente: this.billetePendiente, pregunta: this.pregunta, maquina_lenta: this.tardando }; }

  async responderPregunta(id, aceptar) {
    if (!this.pregunta || this.pregunta.id !== id) return;
    const vigente = Date.now() < Date.parse(this.pregunta.vence_en);
    clearTimeout(this.timerPregunta); this.timerPregunta = null; this.pregunta = null;
    await this.orden(aceptar && vigente ? 3 : 32);
  }

  #aviso(codigo, p) {
    if ([107, 108, 109].includes(codigo) && p[2] !== '0') this.eventoInesperado = true;
    if (codigo === 102) this.nivelesBajos = niveles(p[0], p[1], 'EUR');
    if (codigo === 113) this.billetePendiente = entero(p[0], 1) === 1;
    if (codigo === 110) {
      this.avisos.push({ codigo: entero(p[0], 10000), texto: String(p[1] ?? '').slice(0, 300), recibido_en: new Date().toISOString() });
      this.avisos = this.avisos.slice(-20);
    }
    if ([103, 105].includes(codigo)) {
      if (this.pregunta || (codigo === 105 && p[3] !== '0')) { this.eventoInesperado = true; return; }
      const id = randomUUID();
      this.pregunta = { id, tipo: codigo === 103 ? 'muchas_monedas' : 'proteccion_cambio', vence_en: new Date(Date.now() + (this.plazoPregunta ?? 50000)).toISOString(),
        ...(codigo === 103 ? { denominaciones: niveles(p[0], p[1], 'EUR') } : { valor: entero(p[0]), necesario: entero(p[1]), disponible: entero(p[2]) }) };
      this.timerPregunta = setTimeout(() => { void this.responderPregunta(id, false).catch(() => { this.eventoInesperado = true; }); }, this.plazoPregunta ?? 50000);
      this.timerPregunta.unref?.();
    }
    if (codigo === 100) { clearTimeout(this.timerPregunta); this.timerPregunta = null; this.pregunta = null; }

    if (codigo === 106) {
      const antes = this.estado;
      this.estado = Number(p[0]);
      if (this.estado === 6 && antes !== 6) log(`✗ CashKeeper (directo) ${this.donde}: la máquina está en error`);
    }
    if (codigo === 100 && !this.esperandoDisabled) this.eventoInesperado = true;
    if (codigo === 104) {
      this.interrumpida = { estado: entero(p[0], 7), valor: entero(p[1]), objetivo: entero(p[2]), operacion: entero(p[3], 255) };
      log(`CashKeeper (directo) ${this.donde}: había algo a medias al cortarse (${ESTADO_CK[this.interrumpida.estado] ?? this.interrumpida.estado}: ${euros(this.interrumpida.valor)} de ${euros(this.interrumpida.objetivo)})`);
    }
    if (codigo === 110) log(`CashKeeper (directo) ${this.donde}: aviso de la máquina: ${p[1] ?? ""} (${p[0] ?? "?"})`);
    this.emit(String(codigo), p);
  }

  #cortada(conexion) {
    if (this.conexion !== conexion) return;
    this.conexion = null;
    this.lista = false;
    this.estado = 0;
    this.desfasada = false;
    clearTimeout(this.timerPregunta); this.timerPregunta = null; this.pregunta = null;
    if (this.esperando) {
      const e = this.esperando;
      this.esperando = null;
      e.rechazar(new Error(`Se cortó la conexión con la máquina en ${this.donde}`));
    }
    if (this.negociando) {
      const n = this.negociando;
      this.negociando = null;
      n.rechazar(new Error(n.siSeCierra ?? `La máquina cerró la conexión en ${this.donde}`));
    }
    this.emit("cortada");
  }

  /** Tenerla conectada y arrancada todo el día (si se corta, vuelve sola), y comprobar cada 20 s que contesta. */
  mantenerViva() {
    if (this.mantener || this.pausada) return;
    this.mantener = true;
    const vuelta = async () => {
      if (!this.mantener || this.pausada) return;
      try {
        if (!this.lista) {
          await this.asegurar();
          log(`✓ CashKeeper (directo): conectado con la máquina en ${this.donde} (${ESTADO_CK[this.estado] ?? this.estado})`);
        } else if (!this.ocupada) {
          await this.orden(40, [], 8000).catch((error) => {
            if (!(error.codigo >= 0)) throw error; // contestó (aunque sea con error): sigue viva
          });
        }
      } catch (error) {
        this.fallos++;
        if (this.fallos === 1 || this.fallos % 60 === 0) log(`✗ CashKeeper (directo): ${error.message}; se vuelve a intentar`);
      }
      if (this.mantener) this.vigilancia = setTimeout(vuelta, this.lista ? 20_000 : 5_000);
    };
    vuelta();
  }

  /** Dejarla (ya no es de este ordenador): se suelta la conexión y la máquina se cierra sola. */
  soltar() {
    this.mantener = false;
    clearTimeout(this.vigilancia);
    this.conexion?.destroy();
  }
}

/** Una máquina por dirección (la misma conexión para todas sus operaciones). */
const maquinasDirectas = new Map();
export function maquinaDirecta(host, puerto, semilla) {
  const clave = `${host}:${Number(puerto) || 8001}`;
  let m = maquinasDirectas.get(clave);
  if (m && semilla && m.semilla !== String(semilla)) {
    // Clave nueva desde la oficina: se cambia con la máquina libre (soltarla a medio cobro la cerraría a medias).
    if (!m.libreDeOperaciones) return m;
    m.soltar();
    m = null;
  }
  if (!m) {
    m = new MaquinaDirecta(host, puerto, semilla);
    m.pausada = conexionesCajon.leer(clave)?.pausada === true;
    m.guardarPausa = pausada => conexionesCajon.guardar(clave, { pausada, actualizado: new Date().toISOString() });
    maquinasDirectas.set(clave, m);
  }
  return m;
}

/** Las máquinas que la oficina dice que lleva este ordenador sin CKMonitor: se conectan y se mantienen. */
function mantenerMaquinas(lista = []) {
  const quedan = new Set();
  for (const c of lista) {
    const m = maquinaDirecta(c.host, c.puerto, c.semilla);
    quedan.add(`${m.host}:${m.puerto}`);
    m.mantenerViva();
  }
  for (const [clave, m] of maquinasDirectas) {
    if (!quedan.has(clave) && m.mantener && m.libreDeOperaciones) {
      m.soltar();
      maquinasDirectas.delete(clave);
    }
  }
}

/** Una operación física por turno. Tras un corte, conserva el resultado incierto sin repetir dinero. */
export async function operarDirecto(op, avisar, { maquina, diario = diarioCajon } = {}) {
  const m = maquina ?? maquinaDirecta(op.host, op.puerto, op.semilla);
  return m.enTurno(async () => {
    m.ocupada = true;
    m.evidenciaFin = null;
    m.raroEnOperacion = false;
    const consulta = op.tipo === "prueba" || esConsultaHerramienta(op);
    let liberar; let iniciada = false; let enviado = false; let revision = false; let ultimoProgreso; let finalGuardada;
    let acabada = false; let ultimoAviso = Date.now(); let ultimoResultado;
    const informar = async (estado, error, resultado, progreso) => {
      ultimoAviso = Date.now();
      if (estado === "en_curso") ultimoResultado = resultado;
      else acabada = true;
      // Si llegó algo de la máquina que no se entiende, lo que diga el final no es del todo de fiar: queda para revisar.
      if (["cobrada", "cancelada"].includes(estado) && !consulta && m.raroEnOperacion) {
        estado = "error";
        error = "La máquina mandó algo que no se entiende durante la operación: revisa el efectivo antes de seguir";
        revision = true;
      }
      if (progreso) { ultimoProgreso = progreso; if (iniciada && !consulta) diario.avance(op.id, { progreso }); }
      if (estado !== "en_curso" && !progreso) progreso = ultimoProgreso;
      // Toda incertidumbre mantiene bloqueada la máquina, también tras reiniciar.
      if (estado === "error" && !consulta) {
        const soloAjustes = op.tipo === "mantenimiento" && ["configurar", "guardar_niveles", "guardar_propiedades", "limpiar", "idioma", "pantalla", "mensaje"].includes(op.herramienta?.accion);
        resultado = { ...(resultado ?? {}), conciliar: soloAjustes ? false : enviado || revision };
      }
      if (m.observaciones) resultado = { ...(resultado ?? {}), ...m.observaciones() };
      const cuerpo = { estado, ...(error ? { error: String(error).slice(0, 300) } : {}), ...(resultado ? { resultado } : {}), ...(progreso ? { progreso } : {}) };
      if (iniciada && estado !== "en_curso" && !consulta) { diario.terminar(op.id, cuerpo); finalGuardada = cuerpo; }
      const respuesta = await avisar(estado, error, resultado, progreso);
      if (respuesta?.decision && m.responderPregunta) await m.responderPregunta(respuesta.decision.id, respuesta.decision.aceptar === true);
      return respuesta;
    };
    // La señal de vida no espera a la máquina: si tarda en contestar, la plataforma sabe que esto sigue (y la caja lo avisa).
    // Lo normal es contar cada segundo; si en 4 s no se ha contado nada, se cuenta lo último.
    const cadaLatido = m.latidoCajon ?? 4000;
    const latido = setInterval(() => {
      if (acabada || Date.now() - ultimoAviso < cadaLatido) return;
      void informar("en_curso", null, ultimoResultado, ultimoProgreso).catch(() => {});
    }, Math.min(1000, cadaLatido));
    latido.unref?.();
    try {
      if (!consulta) {
        liberar = diario.bloquear(op);
        const previo = diario.iniciar(op);
        if (previo?.final) return avisar(previo.final.estado, previo.final.error, previo.final.resultado, previo.final.progreso);
        if (previo) { revision = true; throw new Error("Operación iniciada antes de reiniciar: requiere conciliación. No se repite."); }
        iniciada = true;
        m.antesDeEnviar = codigo => {
          if ([3, 6, 7, 9, 10, 11, 12, 13, 14, 27, 29, 30, 32, 35, 36, 42, 52, 60, 67, 68, 70, 71, 87].includes(codigo)) { diario.avance(op.id, { comando: codigo, enviado: true }); enviado = true; }
        };
        m.marcarRevision = (fase, saldo) => { revision = true; diario.avance(op.id, { fase, ...(saldo ? { saldo } : {}) }); };
      }
      if (op.tipo === "mantenimiento") return await herramienta(m, op, informar);
      await reposoSeguro(m);
      m.mantenerViva();
      await operarEnMaquina(m, op, informar);
    } catch (error) {
      if (finalGuardada) return avisar(finalGuardada.estado, finalGuardada.error, finalGuardada.resultado, finalGuardada.progreso);
      revision ||= !!error.conciliar;
      // Un rechazo explícito del primer comando de pago no mueve dinero.
      if (error.rechazoSeguro && !revision) enviado = false;
      log(`CashKeeper: operación ${op.id} detenida; requiere revisión`);
      await informar("error", error.message, m.evidenciaFin ? { fin: m.evidenciaFin } : undefined);
    } finally { clearInterval(latido); m.antesDeEnviar = null; m.marcarRevision = null; m.ocupada = false; liberar?.(); }
  });
}

/** Las operaciones del cajón que se están llevando (cada una en paralelo: no frenan la impresión). */
const cajonEnMarcha = new Set();
/** Cómo acabaron (si la plataforma las vuelve a dar porque no se enteró, se le cuenta otra vez: no se repiten). */
const terminadas = new Map();

/** Cuenta a la plataforma cómo acabó una operación del cajón, insistiendo si no hay conexión (hasta media hora). */
async function contarFinal(configuracion, id, cuerpo) {
  for (let intento = 1; ; intento++) {
    try {
      return await llamarApi(configuracion, "POST", `/cajon/${id}/estado`, cuerpo);
    } catch (fallo) {
      // Si la plataforma lo rechaza (4xx), no se insiste; sin conexión o con un fallo suyo, sí.
      if (fallo.estado >= 400 && fallo.estado < 500) {
        log(`✗ La plataforma no acepta cómo acabó el cajón (${cuerpo.estado}): ${fallo.message}`);
        return null;
      }
      if (intento === 1 || intento % 10 === 0) log(`No se pudo contar a la plataforma cómo acabó el cajón (${cuerpo.estado}): ${fallo.message}. Se vuelve a intentar.`);
      if (intento >= 120) return null;
      await dormir(Math.min(1000 * intento, 15_000));
    }
  }
}

/**
 * Lleva una operación del cajón de principio a fin y cuenta cómo va y cómo acabó. Cómo acabó tiene que llegar a la
 * plataforma (si no, la daría otra vez y se repetiría en la máquina: un cobro, un vaciado…): se insiste aparte, sin tener
 * parada la máquina, y la operación sigue «en marcha» aquí hasta que llega. Nunca lanza.
 */
async function vigilarCajon(configuracion, op) {
  const finales = [];
  const avisar = (estado, error, resultado, progreso) => {
    const cuerpo = {
      estado,
      ...(error ? { error: String(error).slice(0, 300) } : {}),
      ...(resultado ? { resultado } : {}),
      ...(progreso ? { progreso } : {}),
    };
    if (estado === "en_curso") {
      return llamarApi(configuracion, "POST", `/cajon/${op.id}/estado`, cuerpo).catch((fallo) => log(`No se pudo contar a la plataforma cómo va el cajón: ${fallo.message}`));
    }
    terminadas.set(op.id, { cuerpo, en: Date.now() });
    for (const [id, t] of terminadas) if (Date.now() - t.en > 2 * 3600_000) terminadas.delete(id);
    finales.push(contarFinal(configuracion, op.id, cuerpo));
    return Promise.resolve(null);
  };
  try {
    await llevarCajon(op, avisar);
  } finally {
    await Promise.all(finales);
  }
}

/**
 * Una operación del cajón: crea el tiquet (si ya existía, es que se retoma), pregunta cada segundo cómo va, avisa a la
 * plataforma cada 15 s mientras espera y cuenta cómo acabó. Si CKMonitor deja de contestar un momento, sigue esperando:
 * el cliente puede estar metiendo el dinero. Sin CKMonitor, la conexión directa (operarDirecto). Nunca lanza.
 */
async function llevarCajon(op, avisar) {
  const donde = `${op.host}:${op.puerto}`;
  // Un instalador va a cerrar el programa: no se empieza nada nuevo (no ha tocado la máquina: no hay nada que revisar).
  if (!op.reanudar && op.tipo !== "consulta" && seEstaActualizando(DATOS)) {
    log(`CashKeeper: operación ${op.id} rechazada porque se está actualizando el programa`);
    return avisar("error", "Se está actualizando el programa del ordenador de la caja: vuelve a intentarlo en un minuto.", { conciliar: false });
  }
  // Sin CKMonitor: la conexión directa con la máquina (desde la 0.6.0).
  if (op.modo === "directo" && op.tipo !== "consulta") return operarDirecto(op, avisar);
  try {
    // Leer el efectivo (no pasa por CKMonitor: va a la propia máquina, solo consulta).
    if (op.tipo === "consulta") {
      try {
        const leido = await leerEfectivo(op.host, op.puerto, op.semilla ?? "100001");
        log(`✓ CashKeeper: efectivo leído en ${donde}: ${euros(totalDe(leido.cambio))} para cambio y ${euros(totalDe(leido.recaudacion))} en recaudación`);
        await avisar("cobrada", null, leido);
      } catch (error) {
        log(`✗ CashKeeper: no se pudo leer el efectivo en ${donde}: ${error.message}`);
        await avisar("error", error.message);
      }
      return;
    }
    if (op.tipo === "prueba") {
      const respuesta = await ordenCkfast(op.host, op.puerto, `S|${op.ticket}`);
      if (/^N?OK\|/.test(respuesta)) {
        log(`✓ CashKeeper: CKMonitor contesta en ${donde} («${respuesta}»)`);
        await avisar("cobrada");
      } else {
        await avisar("error", explicarCkfast(respuesta));
      }
      return;
    }
    return operarCkfast(op, avisar, { diario: diarioCajon, orden: orden => ordenCkfast(op.host, op.puerto, orden) });
  } catch (error) {
    await avisar("error", String(error.message ?? error));
  }
}

// Hablar con la plataforma ------------------------------------------------------------------------------------------

async function llamarApi(configuracion, metodo, ruta, cuerpo) {
  const respuesta = await fetch(`${apiDe(configuracion)}/v1/agente${ruta}`, {
    method: metodo,
    headers: {
      ...(configuracion.token ? { authorization: `Bearer ${configuracion.token}` } : {}),
      "x-agente-version": VERSION,
      "content-type": "application/json",
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    const error = new Error(datos.error ?? `${metodo} ${ruta} → ${respuesta.status}`);
    error.estado = respuesta.status;
    throw error;
  }
  return datos;
}

/** Enlaza este ordenador con el código corto de la oficina y guarda su token. */
async function enlazar(codigo) {
  const anterior = leerConfiguracion();
  const api = apiDe(anterior);
  const respuesta = await llamarApi({ api }, "POST", "/enlazar", { codigo, equipo: os.hostname().slice(0, 120), sistema: SISTEMA });
  guardarConfiguracion({ token: respuesta.token, api, agente: respuesta.agente.nombre, negocio: respuesta.negocio.nombre });
  return respuesta;
}

async function procesarTrabajo(configuracion, trabajo) {
  const datos = Buffer.from(trabajo.datos, "base64");
  try {
    for (let copia = 0; copia < (trabajo.copias ?? 1); copia++) {
      if (trabajo.impresora.tipo === "sistema") await imprimirEnSistema(trabajo.impresora.nombre_sistema, datos, trabajo.titulo);
      else await imprimirEnRed(trabajo.impresora.direccion, trabajo.impresora.puerto, datos);
    }
    await llamarApi(configuracion, "POST", `/trabajos/${trabajo.id}/resultado`, { estado: "impreso" });
    log(`✓ ${trabajo.titulo} → ${trabajo.impresora.nombre}`);
  } catch (error) {
    const mensaje = String(error.message ?? error).slice(0, 300);
    await llamarApi(configuracion, "POST", `/trabajos/${trabajo.id}/resultado`, { estado: "error", error: mensaje }).catch(() => {});
    log(`✗ ${trabajo.titulo} → ${trabajo.impresora.nombre}: ${mensaje}`);
  }
}

/** El bucle de siempre: recoge lo pendiente (espera hasta 25 s) y lo imprime; cada 5 minutos cuenta sus impresoras. */
async function trabajar() {
  log(`Agente de impresión ${VERSION} (${SISTEMA}, ${os.hostname()})`);
  // La marca de «operación del cajón en marcha» se renueva mientras dure (sin renovar, el instalador la da por vieja).
  setInterval(() => { if (cajonEnMarcha.size > 0) marcarCajon(DATOS, true); }, 10_000);
  let ultimoLatido = 0;
  let fallos = 0;
  for (;;) {
    const configuracion = { ...leerConfiguracion(), ...(process.env.TPV_AGENTE_TOKEN ? { token: process.env.TPV_AGENTE_TOKEN } : {}) };
    if (!configuracion.token) {
      log("Sin enlazar: abre el programa y escribe el código de la oficina (Impresión y pantallas → Conectar un ordenador).");
      await dormir(60_000);
      continue;
    }
    try {
      if (Date.now() - ultimoLatido > 5 * 60_000) {
        const impresoras = await detectarImpresoras().catch((error) => {
          log(`No se pudieron mirar las impresoras del ordenador: ${error.message}`);
          return undefined;
        });
        const latido = await llamarApi(configuracion, "POST", "/latido", { version: VERSION, ...(impresoras ? { impresoras } : {}) });
        ultimoLatido = Date.now();
        mantenerMaquinas(latido.cajones_directos ?? []);
        const lista = latido.impresoras.map((i) => i.nombre).join(", ");
        log(`Conectado como «${latido.agente.nombre}» · ${impresoras?.length ?? 0} impresoras en el ordenador · asignadas: ${lista || "ninguna todavía"}`);
      }
      const { trabajos, cajon = [] } = await llamarApi(configuracion, "GET", "/trabajos?espera=25");
      fallos = 0;
      for (const m of maquinasDirectas.values()) {
        if (m.ocupada || m.pausada) continue;
        await recuperarCancelacionesVacias(m, m, diarioCajon, id => llamarApi(configuracion, "GET", `/cajon/${id}/revision`),
          (id, datos) => llamarApi(configuracion, "POST", `/cajon/${id}/revision`, datos))
          .catch(error => log(`CashKeeper: no se pudo aplicar la revisión de la cancelación: ${error.message}`));
        // Un vaciado de recicladores o un cierre por niveles revisado en la caja: se cierra aquí también (Luis, 24-10).
        await recuperarMantenimientosRevisados(m, m, diarioCajon, id => llamarApi(configuracion, "GET", `/cajon/${id}/revision`),
          (id, datos) => llamarApi(configuracion, "POST", `/cajon/${id}/revision`, datos))
          .catch(error => log(`CashKeeper: no se pudo aplicar la revisión del mantenimiento: ${error.message}`));
        if (diarioCajon.pendientesRecuperacion(m).length && !m.recuperando) {
          m.recuperando = true;
          void recuperarInterrupciones(m, m, diarioCajon,
            id => llamarApi(configuracion, "GET", `/cajon/${id}/recuperacion`),
            (id, datos) => llamarApi(configuracion, "POST", `/cajon/${id}/recuperacion`, datos))
            .catch(e => log(`CashKeeper: recuperación pendiente: ${e.message}`)).finally(() => { m.recuperando = false; });
        }
      }
      // Los cobros del cajón, cada uno por su lado (pueden tardar minutos): la impresión sigue mientras.
      for (const operacion of cajon) {
        if (cajonEnMarcha.has(operacion.id)) continue;
        cajonEnMarcha.add(operacion.id);
        // La marca va antes de mirar si se está actualizando (llevarCajon): el instalador no cierra el programa a medias.
        marcarCajon(DATOS, true);
        // Si ya acabó aquí y la plataforma no se enteró, se le cuenta otra vez (no se repite en la máquina).
        const hecha = terminadas.get(operacion.id);
        const trabajo = hecha ? contarFinal(configuracion, operacion.id, hecha.cuerpo) : vigilarCajon(configuracion, operacion);
        trabajo.finally(() => {
          cajonEnMarcha.delete(operacion.id);
          marcarCajon(DATOS, cajonEnMarcha.size > 0);
        });
      }
      for (const trabajo of trabajos) await procesarTrabajo(configuracion, trabajo);
    } catch (error) {
      if (error.estado === 401) {
        log("La oficina no reconoce este ordenador (¿se borró, o se conectó otro con un código nuevo?). Abre el programa y escribe un código nuevo.");
        ultimoLatido = 0;
        await dormir(60_000);
        continue;
      }
      fallos++;
      log(`Sin conexión con la plataforma: ${error.message}. Se vuelve a intentar.`);
      await dormir(Math.min(5000 * fallos, 60_000));
    }
  }
}

// Con doble clic: enlazar e instalar -----------------------------------------------------------------------------------

async function asistente() {
  console.log(`TPV Lucrapp · Agente de impresión ${VERSION}\n`);
  let enSuSitio = esPrograma && SISTEMA !== "linux";
  if (SISTEMA === "windows" && esPrograma && !esAdministrador()) {
    console.log("Para que imprima solo y arranque con el ordenador, Windows te va a pedir permiso: pulsa «Sí».");
    try {
      abrirComoAdministrador([]);
      process.exit(0); // sigue en la ventana nueva, con permiso
    } catch {
      console.log("\nSin ese permiso no se puede dejar funcionando en segundo plano. Puedes usarlo igual: deja esta ventana abierta.");
      enSuSitio = false;
    }
  }

  const configuracion = leerConfiguracion();
  if (configuracion.token) {
    console.log(`Este ordenador ya está conectado${configuracion.negocio ? ` a «${configuracion.negocio}»` : ""}${configuracion.agente ? ` como «${configuracion.agente}»` : ""}.`);
    const codigo = await preguntar("Si quieres conectarlo con un código nuevo, escríbelo; si no, pulsa Enter: ");
    if (codigo) await conectar(codigo, false);
  } else {
    console.log("En la oficina → Impresión y pantallas → «Conectar un ordenador» sale un código (por ejemplo K7PQ-4XMW).");
    await conectar(await preguntar("Escribe aquí el código y pulsa Enter: "), true);
  }

  if (enSuSitio) {
    console.log("\nDejándolo funcionando en segundo plano…");
    try {
      await instalar();
    } catch (error) {
      await salir(1, `✗ No se pudo dejar en segundo plano: ${error.message}`);
    }
    const impresoras = await detectarImpresoras().catch(() => []);
    console.log("✓ Listo: imprime solo y arrancará cada vez que se encienda el ordenador. No hace falta dejar nada abierto.");
    console.log(
      impresoras.length > 0
        ? `\nImpresoras de este ordenador: ${impresoras.map((i) => i.nombre).join(", ")}.\nDalas de alta en la oficina → Impresión y pantallas → «Añadir impresora».`
        : "\nNo hay impresoras instaladas en este ordenador. También vale una impresora de red por su IP.",
    );
    await salir(0, "\nYa puedes cerrar esta ventana.");
  }
  await trabajar(); // sin arranque automático: trabaja en esta ventana
}

async function conectar(codigo, insistir) {
  let actual = codigo;
  for (;;) {
    if (!actual) await salir(1, "Sin el código no se puede conectar.");
    try {
      const respuesta = await enlazar(actual);
      console.log(`✓ Conectado a «${respuesta.negocio.nombre}» como «${respuesta.agente.nombre}».`);
      return;
    } catch (error) {
      console.log(`✗ ${error.message}`);
      if (!insistir) return;
      actual = await preguntar("Escribe el código otra vez: ");
    }
  }
}

// Qué hacer -----------------------------------------------------------------------------------------------------------

async function main() {
const [orden, valor] = process.argv.slice(2);

if (orden === "--servicio") {
  enSegundoPlano = true;
  await trabajar();
} else if (orden === "--impresoras") {
  try {
    const impresoras = await detectarImpresoras();
    if (impresoras.length === 0) console.log("No hay impresoras instaladas en este ordenador.");
    for (const i of impresoras) console.log(`· ${i.nombre}${i.predeterminada ? " (predeterminada)" : ""} — ${i.estado}${i.driver ? ` · ${i.driver}` : ""}${i.puerto ? ` · ${i.puerto}` : ""}`);
    await salir(0);
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else if (orden === "--probar") {
  const [direccion, puerto = "9100"] = String(valor ?? "").split(":");
  if (!direccion) await salir(1, "Uso: tpvlucrapp-agente --probar 192.168.1.50:9100");
  try {
    await imprimirEnRed(direccion, puerto, paginaDePrueba(`${direccion}:${puerto}`));
    await salir(0, `✓ Enviado a ${direccion}:${puerto}. Si no salió nada, revisa la IP y que la impresora acepte RAW/9100.`);
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else if (orden === "--probar-impresora") {
  if (!valor) await salir(1, 'Uso: tpvlucrapp-agente --probar-impresora "Nombre de la impresora" (mira los nombres con --impresoras)');
  try {
    await imprimirEnSistema(valor, paginaDePrueba(valor), "Prueba de TPV Lucrapp");
    await salir(0, `✓ Enviado a «${valor}».`);
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else if (orden === "--probar-cashkeeper") {
  const [host, puerto = "16501"] = String(valor ?? "").split(":");
  if (!host) await salir(1, "Uso: tpvlucrapp-agente --probar-cashkeeper 127.0.0.1:16501 (la IP del ordenador con CKMonitor y su puerto CKFast)");
  try {
    // Un tiquet que no existe: si CKMonitor está y tiene CKFast activado, contesta «NOK|Not found».
    const respuesta = await ordenCkfast(host, puerto, "S|1");
    await salir(/^N?OK\|/.test(respuesta) ? 0 : 1, `${/^N?OK\|/.test(respuesta) ? "✓" : "✗"} CKMonitor en ${host}:${puerto} contesta «${respuesta || "nada"}».`);
  } catch (error) {
    await salir(1, `✗ ${error.message}. ¿Está CKMonitor abierto en ese ordenador y con CKFast activado (Configuración → Tipo de conector)?`);
  }
} else if (orden === "--leer-cashkeeper") {
  const [host, puerto = "8002"] = String(valor ?? "").split(":");
  const clave = process.argv[4] ?? "100001";
  if (!host) await salir(1, "Uso: tpvlucrapp-agente --leer-cashkeeper 192.168.1.20 [CLAVE] (la IP de la máquina CashKeeper y su clave de consulta; de serie 100001)");
  try {
    const leido = await leerEfectivo(host, puerto, clave);
    const filas = (lista) => lista.filter((x) => x.unidades > 0).map((x) => `  ${euros(x.valor).padStart(9)} × ${String(x.unidades).padStart(4)} = ${euros(x.valor * x.unidades)}`);
    await salir(
      0,
      [
        `✓ Efectivo en la máquina ${host}:${puerto}`,
        "Para dar cambio:",
        ...filas(leido.cambio),
        `  Total: ${euros(totalDe(leido.cambio))}`,
        "En el cajón de recaudación:",
        ...filas(leido.recaudacion),
        `  Total: ${euros(totalDe(leido.recaudacion))}`,
      ].join("\n"),
    );
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else if (orden === "--probar-directo") {
  const [host, puerto = "8001"] = String(valor ?? "").split(":");
  const clave = process.argv[4] ?? "100001";
  if (!host) await salir(1, "Uso: tpvlucrapp-agente --probar-directo 192.168.1.20 [CLAVE] (la IP de la máquina y su clave; de serie 100001). CKMonitor tiene que estar cerrado.");
  const m = maquinaDirecta(host, puerto, clave);
  try {
    await m.asegurar();
    m.soltar();
    await salir(0, `✓ Conectado con la máquina en ${host}:${puerto} sin CKMonitor: está ${ESTADO_CK[m.estado] ?? m.estado}.`);
  } catch (error) {
    m.soltar();
    await salir(1, `✗ ${error.message}. ¿Está CKMonitor cerrado (la máquina solo admite un dueño) y la IP y la clave bien?`);
  }
} else if (orden === "--enlazar") {
  try {
    const respuesta = await enlazar(String(valor ?? ""));
    await salir(0, `✓ Conectado a «${respuesta.negocio.nombre}» como «${respuesta.agente.nombre}».`);
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else if (orden === "--instalar") {
  // Instalación sin preguntas (técnicos y pruebas): primero --enlazar CÓDIGO, luego --instalar.
  if (!esPrograma) await salir(1, "Solo el programa descargado se instala; con Node.js se usa en una ventana.");
  if (SISTEMA === "windows" && !esAdministrador()) {
    try {
      abrirComoAdministrador(["--instalar"]);
      process.exit(0);
    } catch {
      await salir(1, "Para instalarlo hace falta el permiso de administrador.");
    }
  }
  try {
    await instalar();
    await salir(0, "✓ Instalado: funciona en segundo plano y arranca solo con el ordenador.");
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else if (orden === "--desinstalar") {
  if (SISTEMA === "windows" && esPrograma && !esAdministrador()) {
    try {
      abrirComoAdministrador(["--desinstalar"]);
      process.exit(0);
    } catch {
      await salir(1, "Para quitarlo hace falta el permiso de administrador.");
    }
  }
  await desinstalar();
  await salir(0, "✓ Quitado de este ordenador. En la oficina puedes borrarlo de la lista de ordenadores.");
} else if (orden === "--version") {
  console.log(VERSION);
} else {
  await asistente();
}

}
if (esPrograma || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) await main();
