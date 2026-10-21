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
// sin CKMonitor, también vacía el cajón de recaudación y cambia efectivo (la caja elige con qué billetes y monedas).
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
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.6.1";
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
    await ejecutar("taskkill", ["/F", "/FI", "IMAGENAME eq tpvlucrapp-agente.exe", "/FI", `PID ne ${process.pid}`]).catch(() => {});
    await dormir(1500);
  } else if (SISTEMA === "mac") {
    await ejecutar("launchctl", ["bootout", `gui/${process.getuid()}/${ETIQUETA_MAC}`]).catch(() => {});
  }
}

/** Copia el programa a su sitio y lo deja arrancando solo con el ordenador (y en marcha ya). */
async function instalar() {
  await pararEnSegundoPlano();
  fs.mkdirSync(path.dirname(INSTALADO), { recursive: true });
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(INSTALADO).toLowerCase()) fs.copyFileSync(process.execPath, INSTALADO);
  if (SISTEMA === "windows") {
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
    await ejecutar("schtasks", ["/Run", "/TN", NOMBRE_TAREA]);
  } else if (SISTEMA === "mac") {
    fs.chmodSync(INSTALADO, 0o755);
    await ejecutar("xattr", ["-d", "com.apple.quarantine", INSTALADO]).catch(() => {});
    fs.mkdirSync(path.dirname(plistRuta()), { recursive: true });
    fs.writeFileSync(plistRuta(), plistMac(INSTALADO));
    await ejecutar("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistRuta()]);
  }
}

async function desinstalar() {
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

const VALORES_EURO = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

/** Cada valor con sus unidades, de dos listas separadas por comas (y, si viene, la divisa de cada uno). */
function unidadesDe(valores = "", cantidades = "", divisas = "") {
  const v = String(valores).split(",").map((x) => Number(x.trim()));
  const c = String(cantidades).split(",").map((x) => Number(x.trim()));
  const d = String(divisas).split(",").map((x) => x.trim().toUpperCase());
  const lista = [];
  v.forEach((valor, i) => {
    if (!Number.isInteger(valor) || valor <= 0) return;
    if (d.length === v.length && d[i] && d[i] !== "EUR") return;
    lista.push({ valor, unidades: Number.isInteger(c[i]) && c[i] >= 0 ? c[i] : 0 });
  });
  return lista;
}

const totalDe = (lista) => lista.reduce((suma, { valor, unidades }) => suma + valor * unidades, 0);

/** Lee lo que hay en la máquina: { divisa, cambio: [{valor, unidades}], recaudacion: [{valor, unidades}] }. */
function leerEfectivo(host, puerto, semilla, espera = 15000) {
  return new Promise((resolver, rechazar) => {
    const conexion = net.createConnection({ host, port: Number(puerto) || 8002 });
    const resultado = { divisa: "EUR", cambio: [], recaudacion: [] };
    let pendiente = "";
    let claveMandada = false;
    let dentro = false;
    let acabado = false;
    const acabar = (error) => {
      if (acabado) return;
      acabado = true;
      clearTimeout(tiempo);
      conexion.destroy();
      if (error) rechazar(error);
      else resolver(resultado);
    };
    const tiempo = setTimeout(
      () => acabar(new Error(dentro ? `La máquina no contesta a la consulta en ${host}:${puerto}` : `No se puede entrar en la consulta de la máquina en ${host}:${puerto}`)),
      espera,
    );
    const mandar = (orden) => conexion.write(Buffer.from(orden, "ascii"));
    const atender = (codigo, p) => {
      if (codigo === "57" && !claveMandada) {
        claveMandada = true;
        const clave = Number(p[0]) + Number(semilla);
        if (!Number.isSafeInteger(clave)) throw new Error("La máquina no ha dado el número para la clave de consulta");
        return mandar(`$57|${clave}#`);
      }
      if (codigo === "58") {
        dentro = true;
        return mandar("$79|0#");
      }
      if (codigo === "79") {
        if (p[0] !== "1") return mandar(`$19|${VALORES_EURO.join(",")}#`);
        resultado.cambio = unidadesDe(p[1], p[2], p[3]);
        return mandar("$17#");
      }
      if (codigo === "19") {
        if (p[0] !== "1") throw new Error(`La máquina no deja leer lo que hay para dar cambio (${p.slice(1).join(" ")})`);
        resultado.cambio = unidadesDe(VALORES_EURO.join(","), p[1]);
        return mandar("$17#");
      }
      if (codigo === "17") {
        if (p[0] !== "1") throw new Error(`La máquina no deja leer el cajón de recaudación (${p.slice(1).join(" ")})`);
        if (p[1] && p[1].toUpperCase() !== "EUR") resultado.recaudacion = [];
        else resultado.recaudacion = unidadesDe(p[2], p[3]);
        return acabar(null);
      }
      // Lo demás (eventos como «$106|2#», cambios de estado): no se pide, no se usa.
    };
    conexion.setEncoding("latin1");
    conexion.on("connect", () => mandar("$47#"));
    conexion.on("data", (trozo) => {
      pendiente += trozo;
      for (let fin = pendiente.indexOf("#"); fin >= 0; fin = pendiente.indexOf("#")) {
        const mensaje = pendiente.slice(0, fin);
        pendiente = pendiente.slice(fin + 1);
        const inicio = mensaje.indexOf("$");
        if (inicio < 0) continue;
        const partes = mensaje.slice(inicio + 1).split("|").map((x) => x.trim());
        try {
          atender(partes[0], partes.slice(1));
        } catch (error) {
          return acabar(error);
        }
      }
    });
    // Con la clave mala, la máquina cierra la conexión sin decir nada.
    conexion.on("end", () =>
      acabar(new Error(dentro ? "La máquina cortó la consulta" : "La máquina no acepta la clave de consulta (de serie 100001): revísala en la oficina")),
    );
    conexion.on("error", (error) => acabar(error));
  });
}
// Conexión directa con el CashKeeper, sin CKMonitor (desde la 0.6.0) ---------------------------------------------------
// Manual del integrador §7 (CKeeper) y §8 (Raw Sockets), con el anexo 9.2. El programa abre la conexión de control de
// la máquina (Host, puerto 8001), entra con la clave (como la consulta) y la arranca (39 Startup). La conexión se queda
// abierta todo el día: si se corta, la máquina se cierra sola y hay que arrancarla otra vez; si se cortó a medio cobro, al
// arrancar lo avisa (104 ProcessInterrupted) y se sigue con ese cobro. Una orden cada vez («$código|parámetros#» →
// «$código|1|…#» o «$código|0|error|texto#»); los avisos de la máquina (códigos de 100 en adelante) llegan cuando
// quieren: 100 Disabled (acabó lo que hacía), 104 ProcessInterrupted, 106 StateChange, 107 ValueIN (lo metido),
// 108 ValueOUT (lo que sale), 110 Warning. Cobrar: 42 Totalize (con la vuelta automática); cancelar: 9 Disable con
// devolución; pagar: 29 Pay; meter cambio: 67 ActivateRefillMode + 42 Totalize. Nunca 48 Terminate ni 7 CloseAll (para
// cerrar basta con soltar la conexión). Con esta conexión, CKMonitor tiene que estar cerrado: la máquina tiene un dueño.

const ESTADO_CK = ["cerrada", "en reposo", "esperando el dinero", "pagando", "llevando a recaudación", "vaciando", "en error", "contando el dinero"];
/** Estados en los que la máquina estaba recogiendo dinero (para un corte a medias). */
const RECOGIENDO = new Set([2, 7]);

class MaquinaDirecta extends EventEmitter {
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
    this.ocupada = false;
    this.interrumpida = null;
    this.mantener = false;
    this.vigilancia = null;
    this.fallos = 0;
  }

  get donde() {
    return `${this.host}:${this.puerto}`;
  }

  /** Conectada, con la clave y arrancada (si no lo estaba, lo hace ahora). */
  asegurar() {
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
    this.pendiente = "";
    conexion.on("data", (trozo) => this.#recibir(trozo));
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

  /** Una orden de bajo nivel (sin turno): la usan la conexión y `orden`. */
  #enviar(codigo, parametros, espera) {
    return new Promise((resolver, rechazar) => {
      if (!this.conexion) return rechazar(new Error(`Sin conexión con la máquina en ${this.donde}`));
      const tiempo = setTimeout(() => {
        this.esperando = null;
        rechazar(new Error(`La máquina no contesta (orden ${codigo})`));
        // Una conexión que no contesta no es de fiar: se cierra y se vuelve a abrir.
        this.conexion?.destroy();
      }, espera);
      this.esperando = {
        codigo: String(codigo),
        resolver: (p) => (clearTimeout(tiempo), resolver(p)),
        rechazar: (e) => (clearTimeout(tiempo), rechazar(e)),
      };
      this.conexion.write(Buffer.from(`$${codigo}${parametros.length ? `|${parametros.join("|")}` : ""}#`, "latin1"));
    });
  }

  /** Una orden a la máquina (de una en una): los datos tras el «1» o un error con el código y el texto de la máquina. */
  orden(codigo, parametros = [], espera = 10_000) {
    const turno = this.cola.then(async () => {
      await this.asegurar();
      return this.#enviar(codigo, parametros, espera);
    });
    this.cola = turno.catch(() => {});
    return turno;
  }

  /** Las operaciones, de una en una: la máquina no puede cobrar y pagar a la vez. */
  enTurno(trabajo) {
    const turno = this.turno.then(trabajo);
    this.turno = turno.catch(() => {});
    return turno;
  }

  #recibir(trozo) {
    this.pendiente += trozo;
    for (let fin = this.pendiente.indexOf("#"); fin >= 0; fin = this.pendiente.indexOf("#")) {
      const mensaje = this.pendiente.slice(0, fin);
      this.pendiente = this.pendiente.slice(fin + 1);
      const inicio = mensaje.indexOf("$");
      if (inicio < 0) continue;
      const [codigo, ...p] = mensaje.slice(inicio + 1).split("|").map((x) => x.trim());
      if (this.negociando && codigo === this.negociando.codigo) {
        const n = this.negociando;
        this.negociando = null;
        n.resolver(p);
        continue;
      }
      if (Number(codigo) >= 100) {
        this.#aviso(Number(codigo), p);
        continue;
      }
      if (this.esperando && codigo === this.esperando.codigo) {
        const e = this.esperando;
        this.esperando = null;
        if (p[0] === "1") e.resolver(p.slice(1));
        else {
          const error = new Error(p[2] ? `${p[2]} (error ${p[1]} de la máquina)` : `La máquina no ha podido hacerlo (orden ${codigo}, error ${p[1] ?? "?"})`);
          error.codigo = Number(p[1]);
          e.rechazar(error);
        }
      }
      // Otra respuesta suelta (no se esperaba): se ignora.
    }
  }

  #aviso(codigo, p) {
    if (codigo === 106) {
      const antes = this.estado;
      this.estado = Number(p[0]);
      if (this.estado === 6 && antes !== 6) log(`✗ CashKeeper (directo) ${this.donde}: la máquina está en error`);
    }
    if (codigo === 104) {
      this.interrumpida = { estado: Number(p[0]), valor: Number(p[1]) || 0, objetivo: Number(p[2]) || 0 };
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
    if (this.mantener) return;
    this.mantener = true;
    const vuelta = async () => {
      if (!this.mantener) return;
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
function maquinaDirecta(host, puerto, semilla) {
  const clave = `${host}:${Number(puerto) || 8001}`;
  let m = maquinasDirectas.get(clave);
  if (m && semilla && m.semilla !== String(semilla)) {
    m.soltar();
    m = null;
  }
  if (!m) {
    m = new MaquinaDirecta(host, puerto, semilla);
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
    if (!quedan.has(clave) && m.mantener && !m.ocupada) {
      m.soltar();
      maquinasDirectas.delete(clave);
    }
  }
}

/** Espera a que la máquina vuelva tras un corte (como mucho `ms`). */
async function esperarVuelta(m, ms) {
  const limite = Date.now() + ms;
  for (;;) {
    try {
      await m.asegurar();
      return;
    } catch (error) {
      if (Date.now() > limite) throw error;
      await dormir(3000);
    }
  }
}

/**
 * Una operación por la conexión directa, de principio a fin. Meter dinero (cobro, entrada): 42 Totalize con la vuelta
 * automática (en la entrada, antes 67: lo que entra va al cambio); cada segundo se cuenta cómo va (lo metido y la vuelta)
 * y, si la caja pide cancelar, 9 Disable con devolución. Sacar dinero (devolución, salida): 29 Pay. Acaba cuando la
 * máquina avisa (100 Disabled). Si la conexión se corta a medias, se espera a que vuelva y se sigue con lo que la
 * máquina tenía (104 ProcessInterrupted). Nunca lanza.
 */
async function operarDirecto(op, avisar) {
  const m = maquinaDirecta(op.host, op.puerto, op.semilla);
  // Una máquina sin CKMonitor tiene que estar siempre conectada y arrancada (si no, no acepta dinero).
  m.mantenerViva();
  return m.enTurno(async () => {
    m.ocupada = true;
    try {
      await operarEnMaquina(m, op, avisar);
    } catch (error) {
      log(`✗ CashKeeper (directo) ${m.donde}: ${error.message}`);
      await avisar("error", error.message);
    } finally {
      m.ocupada = false;
    }
  });
}

async function operarEnMaquina(m, op, avisar) {
  if (op.tipo === "prueba") {
    await m.asegurar();
    log(`✓ CashKeeper (directo): la máquina contesta en ${m.donde} (${ESTADO_CK[m.estado] ?? m.estado})`);
    await avisar("cobrada", null, { estado: ESTADO_CK[m.estado] ?? String(m.estado) });
    return;
  }
  if (op.tipo === "vaciado") return vaciarRecaudacion(m, avisar);
  if (op.tipo === "cambio") return cambiarEfectivo(m, avisar);
  const saca = op.tipo === "devolucion" || op.tipo === "salida";
  const objetivo = op.importe_centimos + (op.propina_centimos ?? 0);
  // Entrada sin importe: la máquina recoge lo que se meta hasta que en la caja pulsen «Aceptar».
  if (op.tipo === "entrada" && objetivo === 0) return entradaAbierta(m, op, avisar);
  const que = { cobro: "cobro", entrada: "entrada de cambio", devolucion: "devolución", salida: "salida" }[op.tipo] ?? op.tipo;
  const fem = op.tipo !== "cobro";
  const hecha = fem ? "hecha" : "hecho";
  const delQue = `${fem ? "de la" : "del"} ${que}`;
  const progreso = { fase: "conectando", objetivo, introducido: 0, devuelto: 0 };
  let cancelarPedido = false;
  let ultimaCuenta = 0;
  const contar = async (estado = "en_curso") => {
    ultimaCuenta = Date.now();
    const r = await avisar(estado, null, null, { ...progreso });
    if (r?.cancelar) cancelarPedido = true;
  };
  // Cada moneda o billete se cuenta al momento (como mucho cada 0,3 s), para que la caja lo vea en vivo.
  const contarYa = () => {
    if (Date.now() - ultimaCuenta > 300) contar().catch(() => {});
  };
  await contar();
  await esperarVuelta(m, 60_000);

  // ¿Quedó algo a medias en la máquina (se cortó)? Si es esta misma operación (se retoma), se sigue; si no, lo metido se
  // devuelve (nadie lo va a cobrar) y lo que se estaba pagando se da por terminado.
  let seguir = false;
  const corte = m.interrumpida;
  m.interrumpida = null;
  if (corte) {
    const esEsta = op.reanudar && corte.objetivo === objetivo && (saca ? corte.estado === 3 : RECOGIENDO.has(corte.estado));
    if (esEsta) {
      seguir = true;
      if (saca) progreso.devuelto = corte.valor;
      else progreso.introducido = corte.valor;
      log(`CashKeeper (directo): se sigue con ${fem ? "la" : "el"} ${que} de ${euros(objetivo)} (${euros(corte.valor)} ya hechos)`);
    } else if (RECOGIENDO.has(corte.estado) && corte.valor > 0) {
      log(`CashKeeper (directo): se devuelven ${euros(corte.valor)} de un cobro cortado que ya no espera nadie`);
      await hastaQueAcabe(m, () => m.orden(42, [0, 1]), () => false).catch((error) => log(`✗ No se pudo devolver lo del cobro cortado: ${error.message}`));
    } else if (corte.estado === 3) {
      await m.orden(68).catch(() => {}); // DiscardPayOperation: el pago cortado no se repite solo
    }
  }

  const alMeter = (p) => {
    progreso.introducido = Number(p[0]) || 0;
    progreso.fase = "metiendo";
    contarYa();
  };
  const alSacar = (p) => {
    progreso.devuelto = Number(p[0]) || 0;
    progreso.fase = saca ? "pagando" : "devolviendo";
    contarYa();
  };
  m.on("107", alMeter);
  m.on("108", alSacar);
  try {
    let cancelando = false;
    let porTiempo = false;
    // Lo que se pidió en el último Pay (si se retoma un pago cortado, solo lo que faltaba).
    let pedido = objetivo;
    const limite = Date.now() + 20 * 60_000;
    const empezar = async () => {
      if (saca) {
        const falta = Math.max(0, objetivo - (seguir ? progreso.devuelto : 0));
        pedido = falta;
        await m.orden(29, [falta, 0]); // Pay
        progreso.fase = "pagando";
      } else {
        if (op.tipo === "entrada" && !seguir) await m.orden(67); // ActivateRefillMode: lo que entre, al cambio
        await m.orden(42, [objetivo, 1]); // Totalize con vuelta automática
        progreso.fase = progreso.introducido > 0 ? "metiendo" : "esperando";
      }
    };
    for (;;) {
      const fin = await hastaQueAcabe(m, empezar, async () => {
        await contar().catch(() => {});
        if (!saca && !cancelando && (cancelarPedido || Date.now() > limite)) {
          cancelando = true;
          porTiempo = !cancelarPedido;
          progreso.fase = "cancelando";
          await m.orden(9, [1]).catch((error) => log(`✗ CashKeeper (directo): no se pudo cancelar: ${error.message}`)); // Disable con devolución
        }
      });
      if (fin.cortada) {
        // Se cortó a medias: la máquina se cierra sola. Se espera a que vuelva y se sigue con lo que tenía.
        log(`CashKeeper (directo): se cortó la conexión a mitad ${delQue}; se espera a la máquina`);
        progreso.fase = "conectando";
        await contar().catch(() => {});
        await esperarVuelta(m, 5 * 60_000);
        const corteAhora = m.interrumpida;
        m.interrumpida = null;
        if (corteAhora && corteAhora.objetivo === objetivo) {
          seguir = true;
          if (saca) progreso.devuelto = corteAhora.valor;
          else progreso.introducido = corteAhora.valor;
          if (cancelando && !saca) {
            await hastaQueAcabe(m, () => m.orden(42, [0, 1]), () => false); // devolver lo metido
            await avisar("cancelada", porTiempo ? "Nadie metió el dinero en 20 minutos: se ha devuelto lo introducido" : null, { ...progreso });
            return;
          }
          continue;
        }
        throw new Error(`Se cortó la conexión con la máquina a mitad ${delQue} y al volver no tenía nada a medias: revisa la máquina`);
      }
      // La máquina terminó (100 Disabled): ErrorCode, ErrorDescription, lo hecho y lo pedido.
      const hecho = fin.actual;
      if (!saca && !fin.error && hecho >= objetivo) {
        log(`✓ CashKeeper (directo): ${que} de ${euros(objetivo)} ${hecha} (metido ${euros(hecho)}${progreso.devuelto ? `, vuelta ${euros(progreso.devuelto)}` : ""})`);
        await avisar("cobrada", null, { ...progreso, introducido: hecho, fase: "hecho" });
      } else if (saca && !fin.error && hecho >= pedido) {
        log(`✓ CashKeeper (directo): ${que} de ${euros(objetivo)} pagada`);
        await avisar("cobrada", null, { ...progreso, devuelto: objetivo - pedido + hecho, fase: "hecho" });
      } else if (cancelando && !fin.error) {
        log(`✗ CashKeeper (directo): ${que} de ${euros(objetivo)} cancelad${fem ? "a" : "o"}${hecho ? ` (devuelto ${euros(hecho)})` : ""}`);
        await avisar("cancelada", porTiempo ? "Nadie metió el dinero en 20 minutos: se ha devuelto lo introducido" : null, { ...progreso, fase: "cancelado" });
      } else {
        const motivo = fin.texto ? `${fin.texto} (error ${fin.error} de la máquina)` : `La máquina terminó sin acabar ${fem ? "la" : "el"} ${que} (${euros(hecho)} de ${euros(objetivo)})`;
        log(`✗ CashKeeper (directo): ${que} de ${euros(objetivo)}: ${motivo}`);
        await avisar("error", saca && hecho > 0 ? `${motivo}. Se llegaron a pagar ${euros(hecho)}` : motivo, { ...progreso });
      }
      return;
    }
  } finally {
    m.off("107", alMeter);
    m.off("108", alSacar);
  }
}

/**
 * Entrada de cambio «abierta» (Luis, 21-10: «no tiene que pedir el importe, sino leer lo que vaya metiendo, y cuando
 * deje de meter dinero, le dé yo a aceptar»): 67 ActivateRefillMode + 14 Enable (la máquina acepta sin importe y lo
 * metido va al cambio); cada moneda se cuenta al momento; con «Aceptar» se pregunta lo metido (43 ValueIN) y se cierra
 * con 42 Totalize por eso mismo (sin vuelta); con «Cancelar», 9 Disable con devolución. A los 20 minutos se cierra con lo
 * que haya (el dinero ya está dentro). Lo que se apunta en la caja es lo aceptado.
 */
async function entradaAbierta(m, op, avisar) {
  const progreso = { fase: "conectando", objetivo: 0, introducido: 0, devuelto: 0 };
  let cancelarPedido = false;
  let terminarPedido = false;
  let ultimaCuenta = 0;
  const contar = async (estado = "en_curso") => {
    ultimaCuenta = Date.now();
    const r = await avisar(estado, null, null, { ...progreso });
    if (r?.cancelar) cancelarPedido = true;
    if (r?.terminar) terminarPedido = true;
  };
  await contar();
  await esperarVuelta(m, 60_000);
  await devolverLoCortado(m);
  const alMeter = (p) => {
    progreso.introducido = Number(p[0]) || 0;
    progreso.fase = "metiendo";
    if (Date.now() - ultimaCuenta > 300) contar().catch(() => {});
  };
  m.on("107", alMeter);
  try {
    let accion = null;
    let aceptado = 0;
    const limite = Date.now() + 20 * 60_000;
    const fin = await hastaQueAcabe(
      m,
      async () => {
        await m.orden(67); // ActivateRefillMode: lo que entre, al cambio
        await m.orden(14); // Enable: acepta dinero sin importe
        progreso.fase = "esperando";
      },
      async () => {
        await contar().catch(() => {});
        if (accion) return;
        if (cancelarPedido) {
          accion = "cancelar";
          progreso.fase = "cancelando";
          await m.orden(9, [1]).catch((error) => log(`✗ CashKeeper (directo): no se pudo cancelar: ${error.message}`));
          return;
        }
        if (!terminarPedido && Date.now() < limite) return;
        // «Aceptar» (o 20 minutos): lo metido, según la máquina, y cerrar con eso mismo.
        const [valor] = await m.orden(43, [255]).catch(() => [String(progreso.introducido)]);
        aceptado = Number(valor) || progreso.introducido;
        if (aceptado > 0) {
          accion = "aceptar";
          progreso.introducido = aceptado;
          await m.orden(42, [aceptado, 1]); // Totalize por lo metido: se cierra sin vuelta
        } else {
          accion = "cancelar";
          await m.orden(9, [1]).catch(() => {});
        }
      },
    );
    if (fin.cortada) throw new Error("Se cortó la conexión con la máquina a mitad de la entrada: revisa en la máquina si se quedó el dinero");
    if (fin.error) {
      const motivo = fin.texto ? `${fin.texto} (error ${fin.error} de la máquina)` : "La máquina no ha podido terminar la entrada";
      log(`✗ CashKeeper (directo): entrada de cambio: ${motivo}`);
      await avisar("error", motivo, { ...progreso });
    } else if (accion === "aceptar") {
      log(`✓ CashKeeper (directo): entrada de cambio de ${euros(aceptado)} hecha`);
      await avisar("cobrada", null, { ...progreso, objetivo: aceptado, introducido: aceptado, fase: "hecho" });
    } else {
      log(`✗ CashKeeper (directo): entrada de cambio cancelada${progreso.introducido ? ` (devuelto ${euros(progreso.introducido)})` : ""}`);
      await avisar("cancelada", progreso.introducido ? null : "No se metió dinero", { ...progreso, devuelto: progreso.introducido, fase: "cancelado" });
    }
  } finally {
    m.off("107", alMeter);
  }
}

/** Lo que quedó a medias al cortarse la conexión y ya no espera nadie: lo metido se devuelve y un pago se olvida. */
async function devolverLoCortado(m) {
  const corte = m.interrumpida;
  m.interrumpida = null;
  if (!corte) return;
  if (RECOGIENDO.has(corte.estado) && corte.valor > 0) {
    log(`CashKeeper (directo): se devuelven ${euros(corte.valor)} de una operación cortada que ya no espera nadie`);
    await hastaQueAcabe(m, () => m.orden(42, [0, 1]), () => false).catch((error) => log(`✗ No se pudo devolver lo cortado: ${error.message}`));
  } else if (corte.estado === 3) {
    await m.orden(68).catch(() => {}); // DiscardPayOperation: el pago cortado no se repite solo
  }
}

/** Las unidades de cada moneda y billete para dar cambio (79 GetLastLevels; si no la entiende, 19 GetCurrentLevel). */
async function nivelesDeCambio(m) {
  try {
    const [valores, cantidades, divisas] = await m.orden(79, [0]);
    return unidadesDe(valores, cantidades, divisas);
  } catch (error) {
    if (!(error.codigo >= 0)) throw error; // la máquina no contesta: no se insiste
    const [cantidades] = await m.orden(19, [VALORES_EURO.join(",")]);
    return unidadesDe(VALORES_EURO.join(","), cantidades);
  }
}

/** Lo que hay en el cajón de recaudación (17 GetCashBoxLevel). */
async function nivelesDeRecaudacion(m) {
  const [divisa, valores, cantidades] = await m.orden(17);
  return divisa && divisa.toUpperCase() !== "EUR" ? [] : unidadesDe(valores, cantidades);
}

/**
 * Vaciar el cajón de recaudación (desde la 0.6.1; Luis, 21-10): la máquina dice lo que tiene (17 GetCashBoxLevel) y la
 * caja lo enseña; se saca el dinero y, con «Ya lo he vaciado», se mira otra vez y se pone el contador a cero
 * (11 EmptyCashBox, monedas y billetes). Lo que había justo antes es lo que se apunta como salida de caja. Con «Cancelar»
 * (o si nadie lo confirma en 15 minutos) no se toca nada.
 */
async function vaciarRecaudacion(m, avisar) {
  const progreso = { fase: "conectando", objetivo: 0, introducido: 0, devuelto: 0 };
  const pedido = { cancelar: false, terminar: false };
  const contar = async (lectura) => {
    const r = await avisar("en_curso", null, lectura, { ...progreso });
    if (r?.cancelar) pedido.cancelar = true;
    if (r?.terminar) pedido.terminar = true;
  };
  const leer = async () => ({ divisa: "EUR", cambio: await nivelesDeCambio(m).catch(() => []), recaudacion: await nivelesDeRecaudacion(m) });
  await contar();
  await esperarVuelta(m, 60_000);
  await devolverLoCortado(m);
  let lectura = await leer();
  progreso.objetivo = totalDe(lectura.recaudacion);
  if (progreso.objetivo === 0) {
    log("CashKeeper (directo): el cajón de recaudación está vacío");
    await avisar("cancelada", "El cajón de recaudación está vacío: no hay nada que sacar", lectura, { ...progreso, fase: "cancelado" });
    return;
  }
  progreso.fase = "vaciando";
  log(`CashKeeper (directo): en el cajón de recaudación hay ${euros(progreso.objetivo)}; se espera a que lo vacíen`);
  await contar(lectura);
  const limite = Date.now() + 15 * 60_000;
  while (!pedido.cancelar && !pedido.terminar && Date.now() < limite) {
    await dormir(1000);
    await contar().catch(() => {});
  }
  if (!pedido.terminar) {
    log("CashKeeper (directo): vaciado del cajón de recaudación cancelado");
    await avisar("cancelada", pedido.cancelar ? null : "Nadie confirmó el vaciado en 15 minutos: no se ha apuntado nada", null, { ...progreso, fase: "cancelado" });
    return;
  }
  // «Ya lo he vaciado»: lo que había justo antes de ponerlo a cero es lo que se ha sacado.
  lectura = await leer();
  const sacado = totalDe(lectura.recaudacion);
  await m.orden(11, [5]); // EmptyCashBox: monedas y billetes
  log(`✓ CashKeeper (directo): cajón de recaudación vaciado (${euros(sacado)})`);
  if (sacado === 0) {
    await avisar("cancelada", "El cajón de recaudación ya estaba a cero", lectura, { ...progreso, fase: "cancelado" });
    return;
  }
  await avisar("cobrada", null, lectura, { ...progreso, objetivo: sacado, devuelto: sacado, fase: "hecho" });
}

/**
 * Cambiar efectivo (desde la 0.6.1; Luis, 21-10: «meter libremente el importe… que me lo cuente y me diga los billetes o
 * monedas que queramos sacar para dar el cambio… y la cantidad restante»; manual §7.3.1 «Dar cambio»): 14 Enable y cada
 * moneda se cuenta al momento; con «Ya está», 9 Disable sin devolver (la máquina se queda el dinero) y 52
 * DiscardOperation (que no cuente para el siguiente cobro); se leen las unidades de cada moneda y billete y la caja elige
 * con qué dar el cambio, que la máquina paga (30 PaySpecific). Si no lo da todo, se elige otra vez lo que falta. Con
 * «Cancelar» se devuelve lo metido (al meterlo, 9 Disable con devolución; después, 29 Pay de lo que falte por dar). Sin
 * «Ya está» en 20 minutos se sigue con lo metido; sin elegir en 15, se devuelve. Nada se apunta en la caja.
 */
async function cambiarEfectivo(m, avisar) {
  const progreso = { fase: "conectando", objetivo: 0, introducido: 0, devuelto: 0 };
  const pedido = { cancelar: false, terminar: false, seleccion: null };
  let lectura = null;
  let ultimaCuenta = 0;
  const contar = async (conLectura = progreso.fase === "eligiendo") => {
    ultimaCuenta = Date.now();
    const r = await avisar("en_curso", null, conLectura && lectura ? lectura : null, { ...progreso });
    if (r?.cancelar) pedido.cancelar = true;
    if (r?.terminar) pedido.terminar = true;
    if (progreso.fase === "eligiendo" && Array.isArray(r?.seleccion) && r.seleccion.length > 0) pedido.seleccion = r.seleccion;
  };
  const contarYa = () => {
    if (Date.now() - ultimaCuenta > 300) contar().catch(() => {});
  };
  const leer = async () => ({ divisa: "EUR", cambio: await nivelesDeCambio(m), recaudacion: [] });
  // Un pago (29 Pay o 30 PaySpecific): lo que sale se suma a lo ya devuelto. Nunca lanza.
  const pagar = async (empezar) => {
    const base = progreso.devuelto;
    const alPagar = (p) => {
      progreso.devuelto = base + (Number(p[0]) || 0);
      contarYa();
    };
    m.on("108", alPagar);
    try {
      const fin = await hastaQueAcabe(m, empezar, () => contar().catch(() => {}));
      if (!fin.cortada) progreso.devuelto = base + fin.actual;
      return fin;
    } catch (error) {
      return { error: Number.isFinite(error.codigo) ? error.codigo : -1, texto: error.message, actual: 0 };
    } finally {
      m.off("108", alPagar);
    }
  };
  // Devolver lo que falta por dar (la máquina elige las monedas) y acabar.
  const devolver = async (motivo) => {
    const falta = progreso.introducido - progreso.devuelto;
    progreso.fase = "devolviendo";
    await contar().catch(() => {});
    const pagado = await pagar(() => m.orden(29, [falta, 0])); // Pay
    if (!pagado.cortada && !pagado.error && progreso.devuelto >= progreso.introducido) {
      log(`✗ CashKeeper (directo): cambio cancelado; devueltos ${euros(falta)}`);
      await avisar("cancelada", motivo, null, { ...progreso, fase: "cancelado" });
      return;
    }
    const queda = progreso.introducido - progreso.devuelto;
    const porque = pagado.cortada ? "se cortó la conexión" : pagado.texto || `error ${pagado.error} de la máquina`;
    log(`✗ CashKeeper (directo): cambio: no se pudieron devolver ${euros(queda)} (${porque})`);
    await avisar("error", `La máquina no ha podido devolver ${euros(queda)} (${porque}): revisa la máquina`, null, { ...progreso });
  };

  await contar();
  await esperarVuelta(m, 60_000);
  await devolverLoCortado(m);
  // Lo que hay para dar cambio, ya antes de meter nada (la caja lo enseña desde el principio).
  lectura = await leer().catch(() => null);

  // 1. Meter el dinero, hasta «Ya está» (o «Cancelar»).
  const alMeter = (p) => {
    progreso.introducido = Number(p[0]) || 0;
    progreso.fase = "metiendo";
    contarYa();
  };
  const alDevolver = (p) => {
    progreso.devuelto = Number(p[0]) || 0;
    contarYa();
  };
  m.on("107", alMeter);
  m.on("108", alDevolver);
  let accion = null;
  let fin;
  try {
    const limite = Date.now() + 20 * 60_000;
    let desactivadaEn = 0;
    fin = await hastaQueAcabe(
      m,
      async () => {
        await m.orden(14); // Enable: acepta dinero sin importe
        progreso.fase = progreso.introducido > 0 ? "metiendo" : "esperando";
        await contar(true).catch(() => {});
      },
      async () => {
        await contar().catch(() => {});
        if (accion) {
          // Si tras dejar de aceptar la máquina no avisa del final (100), basta con verla en reposo.
          if (accion === "aceptar" && Date.now() - desactivadaEn > 10_000 && m.estado === 1) {
            return { error: 0, texto: "", actual: progreso.introducido, objetivo: 0, operacion: 0 };
          }
          return null;
        }
        const basta = pedido.terminar || Date.now() > limite;
        if (pedido.cancelar || (basta && progreso.introducido === 0)) {
          accion = "cancelar";
          progreso.fase = "cancelando";
          await m.orden(9, [1]).catch((error) => log(`✗ CashKeeper (directo): no se pudo cancelar: ${error.message}`)); // Disable con devolución
        } else if (basta) {
          accion = "aceptar";
          desactivadaEn = Date.now();
          await m.orden(9, [0]); // Disable sin devolver: la máquina se queda lo metido
        }
        return null;
      },
    );
  } finally {
    m.off("107", alMeter);
    m.off("108", alDevolver);
  }
  if (fin.cortada) {
    // Se cortó a medias: al volver, si la máquina tenía el dinero pendiente (104), se devuelve; si ya lo había aceptado,
    // se sigue con lo metido.
    progreso.fase = "conectando";
    await contar().catch(() => {});
    await esperarVuelta(m, 5 * 60_000);
    const corte = m.interrumpida;
    if (corte && RECOGIENDO.has(corte.estado)) {
      await devolverLoCortado(m);
      await avisar("cancelada", "Se cortó la conexión con la máquina mientras se metía el dinero: se ha devuelto lo metido", null, {
        ...progreso,
        devuelto: corte.valor,
        fase: "cancelado",
      });
      return;
    }
    m.interrumpida = null;
    if (accion !== "aceptar") {
      await avisar("error", "Se cortó la conexión con la máquina mientras se metía el dinero: revisa la máquina", null, { ...progreso });
      return;
    }
  } else if (fin.error) {
    const motivo = fin.texto ? `${fin.texto} (error ${fin.error} de la máquina)` : "La máquina no ha podido recoger el dinero";
    log(`✗ CashKeeper (directo): cambio: ${motivo}`);
    await avisar("error", progreso.introducido ? `${motivo}. Revisa la máquina: se habían metido ${euros(progreso.introducido)}` : motivo, null, { ...progreso });
    return;
  } else if (accion !== "aceptar") {
    log(`✗ CashKeeper (directo): cambio cancelado${progreso.introducido ? ` (devuelto ${euros(progreso.introducido)})` : ""}`);
    await avisar("cancelada", progreso.introducido ? null : "No se metió dinero", null, { ...progreso, devuelto: progreso.introducido, fase: "cancelado" });
    return;
  } else if (fin.actual > 0) {
    progreso.introducido = fin.actual;
  }
  progreso.objetivo = progreso.introducido;
  progreso.devuelto = 0;
  await m.orden(52, [fin.operacion ?? 0]).catch(() => {}); // DiscardOperation: que lo metido no cuente para el siguiente cobro
  log(`CashKeeper (directo): cambio: metidos ${euros(progreso.introducido)}; se espera a que la caja elija con qué darlo`);

  // 2. Elegir con qué dar el cambio y darlo (si la máquina no da todo, se elige otra vez lo que falta).
  let hasta = Date.now() + 15 * 60_000;
  for (;;) {
    const falta = progreso.introducido - progreso.devuelto;
    if (falta <= 0) {
      lectura = await leer().catch(() => lectura);
      log(`✓ CashKeeper (directo): cambio de ${euros(progreso.introducido)} dado`);
      await avisar("cobrada", null, lectura, { ...progreso, fase: "hecho" });
      return;
    }
    try {
      lectura = await leer();
    } catch {
      return devolver("No se pudo leer lo que tiene la máquina para dar cambio: se ha devuelto lo metido");
    }
    progreso.fase = "eligiendo";
    pedido.seleccion = null;
    await contar().catch(() => {});
    while (!pedido.seleccion && !pedido.cancelar && Date.now() < hasta) {
      await dormir(1000);
      await contar().catch(() => {});
    }
    if (!pedido.seleccion) return devolver(pedido.cancelar ? null : "Nadie eligió el cambio en 15 minutos: se ha devuelto lo metido");
    const eleccion = pedido.seleccion;
    pedido.seleccion = null;
    const hay = (valor) => lectura.cambio.find((n) => n.valor === valor)?.unidades ?? 0;
    const valida = eleccion.every((e) => Number.isInteger(e.valor) && Number.isInteger(e.unidades) && e.unidades > 0 && e.unidades <= hay(e.valor));
    if (!valida || totalDe(eleccion) !== falta) return devolver("Lo elegido no cuadraba con lo que faltaba por dar: se ha devuelto lo metido");
    progreso.fase = "pagando";
    await contar().catch(() => {}); // la plataforma borra lo elegido (si no lo da todo, se elige otra vez)
    log(`CashKeeper (directo): cambio: se dan ${eleccion.map((e) => `${e.unidades} × ${euros(e.valor)}`).join(", ")}`);
    const pagado = await pagar(() => m.orden(30, [eleccion.map((e) => e.valor).join(","), eleccion.map((e) => e.unidades).join(","), 0])); // PaySpecific
    if (pagado.cortada) {
      const queda = progreso.introducido - progreso.devuelto;
      log(`✗ CashKeeper (directo): cambio: se cortó la conexión mientras se daba (faltaban ${euros(queda)})`);
      await avisar("error", `Se cortó la conexión con la máquina mientras daba el cambio: revisa lo que ha salido (faltaban ${euros(queda)})`, null, { ...progreso });
      return;
    }
    if (pagado.error) log(`✗ CashKeeper (directo): cambio: la máquina no dio todo lo elegido (${pagado.texto || `error ${pagado.error}`}); se elige otra vez lo que falta`);
    hasta = Date.now() + 15 * 60_000;
  }
}

/**
 * Manda `empezar` y espera a que la máquina acabe (100 Disabled) o se corte la conexión. Mientras, cada segundo, `cada`
 * (si devuelve algo, se acaba con eso). Devuelve { error, texto, actual, objetivo, operacion } o { cortada: true }.
 */
async function hastaQueAcabe(m, empezar, cada) {
  let acabar;
  const fin = new Promise((resolver) => (acabar = resolver));
  const alAcabar = (p) =>
    acabar({ error: Number(p[0]) || 0, texto: p[1] ?? "", actual: Number(p[2]) || 0, objetivo: Number(p[3]) || 0, operacion: Number(p[5]) || 0 });
  const alCortar = () => acabar({ cortada: true });
  m.once("100", alAcabar);
  m.once("cortada", alCortar);
  try {
    await empezar();
    for (;;) {
      const resultado = await Promise.race([fin, dormir(1000).then(() => null)]);
      if (resultado) return resultado;
      const acabado = await cada();
      if (acabado) return acabado;
    }
  } finally {
    m.off("100", alAcabar);
    m.off("cortada", alCortar);
  }
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
    const que = op.tipo === "devolucion" ? "devolución" : "cobro";
    // 1. Crear el tiquet en CKMonitor (tres intentos si no contesta).
    for (let intento = 1; ; intento++) {
      try {
        const respuesta = await ordenCkfast(op.host, op.puerto, op.orden);
        if (respuesta === "OK|Added" || respuesta === "NOK|Already exists") break;
        log(`✗ CashKeeper: ${que} de ${euros(op.importe_centimos)}: ${respuesta}`);
        await avisar("error", explicarCkfast(respuesta));
        return;
      } catch (error) {
        if (intento >= 3) {
          log(`✗ CashKeeper: no se puede hablar con CKMonitor en ${donde}: ${error.message}`);
          await avisar("error", `No se puede hablar con CKMonitor en ${donde}: ¿está abierto en ese ordenador?`);
          return;
        }
        await dormir(2000);
      }
    }
    await avisar("en_curso");
    log(`… CashKeeper: ${que} de ${euros(op.importe_centimos)} en CKMonitor${op.reanudar ? " (se retoma)" : ""}`);
    // 2. Preguntar cada segundo hasta que acabe (como mucho 20 minutos).
    const limite = Date.now() + 20 * 60_000;
    let ultimoAviso = Date.now();
    let fallosSeguidos = 0;
    let rarasSeguidas = 0;
    while (Date.now() < limite) {
      await dormir(1000);
      let respuesta;
      try {
        respuesta = await ordenCkfast(op.host, op.puerto, `S|${op.ticket}`);
        fallosSeguidos = 0;
      } catch (error) {
        fallosSeguidos++;
        if (fallosSeguidos === 1 || fallosSeguidos % 60 === 0) log(`CashKeeper: CKMonitor no contesta (${error.message}); se sigue esperando`);
        continue;
      }
      if (respuesta === "OK|OK") {
        log(`✓ CashKeeper: ${que} de ${euros(op.importe_centimos)} hecho`);
        await avisar("cobrada");
        return;
      }
      if (respuesta === "OK|Cancel") {
        log(`✗ CashKeeper: ${que} de ${euros(op.importe_centimos)} cancelado en CKMonitor`);
        await avisar("cancelada");
        return;
      }
      if (respuesta === "NOK|Not found") {
        log(`✗ CashKeeper: ${que} de ${euros(op.importe_centimos)}: ${respuesta}`);
        await avisar("error", explicarCkfast(respuesta));
        return;
      }
      // Una respuesta que no se espera se tolera un rato (puede ser un tropiezo); si sigue, se cuenta.
      if (respuesta !== "OK|Pending") {
        rarasSeguidas++;
        if (rarasSeguidas >= 30) {
          log(`✗ CashKeeper: ${que} de ${euros(op.importe_centimos)}: ${respuesta}`);
          await avisar("error", explicarCkfast(respuesta));
          return;
        }
        continue;
      }
      rarasSeguidas = 0;
      // Señal de vida: si no, la plataforma cree que este programa se paró y se lo daría otra vez.
      if (Date.now() - ultimoAviso > 15_000) {
        ultimoAviso = Date.now();
        await avisar("en_curso");
      }
    }
    await avisar("error", "El CashKeeper no ha terminado en 20 minutos: revisa en CKMonitor si se cobró");
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
      // Los cobros del cajón, cada uno por su lado (pueden tardar minutos): la impresión sigue mientras.
      for (const operacion of cajon) {
        if (cajonEnMarcha.has(operacion.id)) continue;
        cajonEnMarcha.add(operacion.id);
        // Si ya acabó aquí y la plataforma no se enteró, se le cuenta otra vez (no se repite en la máquina).
        const hecha = terminadas.get(operacion.id);
        const trabajo = hecha ? contarFinal(configuracion, operacion.id, hecha.cuerpo) : vigilarCajon(configuracion, operacion);
        trabajo.finally(() => cajonEnMarcha.delete(operacion.id));
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
