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
// cuenta a la caja cómo van (cobrado, cancelado o el motivo si falla).
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
//   tpvlucrapp-agente --desinstalar                     quitarlo de este ordenador
//   (--servicio: lo usa el arranque automático · --enlazar CÓDIGO y --instalar: instalación sin preguntas)
// Con Node.js 18+ también vale (node tpvlucrapp-agente.mjs), pero entonces no arranca solo: se queda en la ventana.
// =====================================================================================
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.5.0";
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
/** Las operaciones del cajón que se están llevando (cada una en paralelo: no frenan la impresión). */
const cajonEnMarcha = new Set();

/**
 * Lleva una operación del cajón de principio a fin: crea el tiquet (si ya existía, es que se retoma), pregunta cada
 * segundo cómo va, avisa a la plataforma cada 15 s mientras espera y cuenta cómo acabó. Si CKMonitor deja de contestar
 * un momento, sigue esperando: el cliente puede estar metiendo el dinero. Nunca lanza.
 */
async function vigilarCajon(configuracion, op) {
  const avisar = (estado, error, resultado) =>
    llamarApi(configuracion, "POST", `/cajon/${op.id}/estado`, {
      estado,
      ...(error ? { error: String(error).slice(0, 300) } : {}),
      ...(resultado ? { resultado } : {}),
    }).catch((fallo) => log(`No se pudo contar a la plataforma cómo va el cajón (${estado}): ${fallo.message}`));
  const donde = `${op.host}:${op.puerto}`;
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
        const lista = latido.impresoras.map((i) => i.nombre).join(", ");
        log(`Conectado como «${latido.agente.nombre}» · ${impresoras?.length ?? 0} impresoras en el ordenador · asignadas: ${lista || "ninguna todavía"}`);
      }
      const { trabajos, cajon = [] } = await llamarApi(configuracion, "GET", "/trabajos?espera=25");
      fallos = 0;
      // Los cobros del cajón, cada uno por su lado (pueden tardar minutos): la impresión sigue mientras.
      for (const operacion of cajon) {
        if (cajonEnMarcha.has(operacion.id)) continue;
        cajonEnMarcha.add(operacion.id);
        vigilarCajon(configuracion, operacion).finally(() => cajonEnMarcha.delete(operacion.id));
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
