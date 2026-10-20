// Prueba del cajón automático (CashKeeper) con el programa ya compilado: una plataforma, un CKMonitor y una impresora de
// red de mentira en este mismo ordenador. Se usa en GitHub (Windows y Mac) antes de publicar una versión.
//   node pruebas/cajon.mjs <programa>        (el .exe compilado, o tpvlucrapp-agente.mjs para probarlo con Node)
// Casos: A se cobra tras unos «Pending»; B es la prueba de «Probar»; C se retoma («Already exists») y se cancela en
// CKMonitor; D falla al crearse; E sufre dos cortes de CKMonitor sin que el cobro se dé por fallido. La impresión no
// espera a los cobros.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const programa = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(programa)) {
  console.error("Uso: node pruebas/cajon.mjs <programa>");
  process.exit(2);
}
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "tpv-cajon-"));
const inicio = Date.now();
const t = () => (Date.now() - inicio) / 1000;
const estados = [];
const resultados = [];
const recibidas = [];
const tickets = { A: "20261020220000000001", B: "20261020220000000002", C: "20261020220000000003", D: "20261020220000000004", E: "20261020220000000005" };
const PUERTO_CK = 16599;
const PUERTO_IMPRESORA = 16598;
const ops = [
  { id: "op-A", tipo: "cobro", ticket: tickets.A, orden: `C|${tickets.A}|2550|Mesa 4 cuenta 12|||Ana`, host: "127.0.0.1", puerto: PUERTO_CK, importe_centimos: 2550, reanudar: false },
  { id: "op-B", tipo: "prueba", ticket: tickets.B, orden: null, host: "127.0.0.1", puerto: PUERTO_CK, importe_centimos: 0, reanudar: false },
  { id: "op-C", tipo: "cobro", ticket: tickets.C, orden: `C|${tickets.C}|900`, host: "127.0.0.1", puerto: PUERTO_CK, importe_centimos: 900, reanudar: true },
  { id: "op-D", tipo: "cobro", ticket: tickets.D, orden: `C|${tickets.D}|100`, host: "127.0.0.1", puerto: PUERTO_CK, importe_centimos: 100, reanudar: false },
  { id: "op-E", tipo: "cobro", ticket: tickets.E, orden: `C|${tickets.E}|700`, host: "127.0.0.1", puerto: PUERTO_CK, importe_centimos: 700, reanudar: false },
];
let primera = true;
let cortesE = 0;

// La plataforma: la primera vez da los cinco cobros y un trabajo de impresión; luego, nada.
const plataforma = http
  .createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", async () => {
      const enviar = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url === "/v1/agente/latido") return enviar({ agente: { nombre: "PC prueba" }, impresoras: [] });
      if (req.url.startsWith("/v1/agente/trabajos?")) {
        if (primera) {
          primera = false;
          const impresora = { id: "i1", nombre: "Barra", tipo: "red", direccion: "127.0.0.1", puerto: PUERTO_IMPRESORA };
          const trabajos = [{ id: "t1", tipo: "prueba", titulo: "Prueba", copias: 1, impresora, datos: Buffer.from("\x1b@hola\n").toString("base64") }];
          return enviar({ ahora: new Date().toISOString(), cajon: ops, trabajos });
        }
        await new Promise((r) => setTimeout(r, 1500));
        return enviar({ ahora: new Date().toISOString(), cajon: [], trabajos: [] });
      }
      const estado = /^\/v1\/agente\/cajon\/([^/]+)\/estado$/.exec(req.url);
      if (estado) {
        const b = JSON.parse(cuerpo);
        estados.push({ id: estado[1], ...b, t: t() });
        return enviar({ estado: b.estado });
      }
      const resultado = /^\/v1\/agente\/trabajos\/([^/]+)\/resultado$/.exec(req.url);
      if (resultado) {
        resultados.push({ id: resultado[1], ...JSON.parse(cuerpo), t: t() });
        return enviar({ ok: true });
      }
      res.writeHead(404);
      res.end("{}");
    });
  })
  .listen(3299, "127.0.0.1");

// CKMonitor (CKFast): una orden por conexión, texto sin fin de línea, respuesta corta.
const pendientes = new Map();
const ckmonitor = net
  .createServer((s) => {
    s.on("data", (d) => {
      const orden = d.toString("ascii");
      recibidas.push(orden);
      const [c, ticket] = orden.split("|");
      let respuesta = "NOK|Unknown command";
      if (c === "C") respuesta = ticket === tickets.C ? "NOK|Already exists" : ticket === tickets.D ? "NOK|Failed" : (pendientes.set(ticket, 0), "OK|Added");
      // E: las dos primeras preguntas, CKMonitor cierra sin contestar (un corte): el cobro no debe darse por fallido.
      if (c === "S" && ticket === tickets.E && cortesE < 2) {
        cortesE++;
        return s.end();
      }
      if (c === "S") {
        if (ticket === tickets.C) respuesta = "OK|Cancel";
        else if (!pendientes.has(ticket)) respuesta = "NOK|Not found";
        else {
          const n = pendientes.get(ticket) + 1;
          pendientes.set(ticket, n);
          respuesta = n < 4 ? "OK|Pending" : "OK|OK";
        }
      }
      s.end(respuesta);
    });
  })
  .listen(PUERTO_CK, "127.0.0.1");

// Impresora de red.
const impresora = net
  .createServer((s) => {
    s.on("data", () => {});
    s.on("end", () => s.end());
  })
  .listen(PUERTO_IMPRESORA, "127.0.0.1");

const [ejecutable, argumentos] = programa.endsWith(".mjs") ? [process.execPath, [programa, "--servicio"]] : [programa, ["--servicio"]];
const hijo = spawn(ejecutable, argumentos, {
  env: { ...process.env, TPV_API: "http://127.0.0.1:3299", TPV_AGENTE_TOKEN: "token-prueba", TPV_AGENTE_DATOS: datos },
  stdio: "ignore",
});

const por = (id) =>
  estados
    .filter((e) => e.id === id)
    .map((e) => e.estado + (e.error ? ` (${e.error})` : ""))
    .join(" → ");
const listo = () => ["op-A", "op-B", "op-C", "op-D", "op-E"].every((id) => estados.some((e) => e.id === id && e.estado !== "en_curso")) && resultados.length > 0;
for (let i = 0; i < 80 && !listo(); i++) await new Promise((r) => setTimeout(r, 500));
hijo.kill();
plataforma.close();
ckmonitor.close();
impresora.close();

const cobradaA = estados.find((e) => e.id === "op-A" && e.estado === "cobrada");
console.log("Órdenes a CKMonitor:", recibidas.join("  ·  "));
console.log("A (cobro):", por("op-A"));
console.log("B (prueba):", por("op-B"));
console.log("C (retomado y cancelado):", por("op-C"));
console.log("D (falla al crearse):", por("op-D"));
console.log("E (cortes):", por("op-E"));
console.log("Impresión:", resultados.map((r) => `${r.id} ${r.estado} a los ${r.t.toFixed(1)} s`).join(", ") || "nada");
let registro = "";
try {
  registro = fs.readFileSync(path.join(datos, "agente.log"), "utf8");
} catch {
  // sin registro
}
const bien =
  recibidas.includes(`C|${tickets.A}|2550|Mesa 4 cuenta 12|||Ana`) &&
  por("op-A") === "en_curso → cobrada" &&
  por("op-B") === "cobrada" &&
  por("op-C") === "en_curso → cancelada" &&
  por("op-D").startsWith("error (CKMonitor no ha podido añadir") &&
  por("op-E") === "en_curso → cobrada" &&
  resultados.length === 1 &&
  resultados[0].estado === "impreso" &&
  resultados[0].t < (cobradaA?.t ?? 99);
if (!bien) console.log("\nRegistro del programa:\n" + registro);
console.log(bien ? "Bien: el programa cobra, retoma, cancela, aguanta cortes y no frena la impresión." : "ALGO FALLA");
process.exit(bien ? 0 : 1);
