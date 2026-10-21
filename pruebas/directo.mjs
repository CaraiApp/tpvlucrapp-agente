// Prueba de la conexión directa con el CashKeeper (sin CKMonitor) con el programa ya compilado: una plataforma y una
// máquina de mentira (pruebas/cashkeeper-de-mentira.mjs) en este mismo ordenador. La usa GitHub (Windows y Mac).
//   node pruebas/directo.mjs <programa>        (el .exe compilado, o tpvlucrapp-agente.mjs para probarlo con Node)
// Casos, en orden (la máquina hace una cosa cada vez): A cobra 7,50 € con 10 € (vuelta 2,50 €); B es «Probar»; C se
// cancela desde la caja con 5 € dentro (la máquina los devuelve); D devuelve 3 €; E pide pagar más de lo que hay (error);
// F mete 10 € de cambio; G se corta a media cobro, vuelve y se sigue con lo que la máquina tenía; H es una entrada sin
// importe: se mete lo que sea (15 €) y se acepta desde la caja; I vacía el cajón de recaudación (120 €); J cambia un
// billete de 50 € por 2 de 20 € y 2 de 5 €; K cambia 20 €: los billetes de 10 € se atascan y se eligen otra vez (4 de 5 €);
// L mete 10 € para cambiar y se cancela al elegir (la máquina los devuelve).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { crearCashKeeper } from "./cashkeeper-de-mentira.mjs";

const programa = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || !fs.existsSync(programa)) {
  console.error("Uso: node pruebas/directo.mjs <programa>");
  process.exit(2);
}
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "tpv-directo-"));
const PUERTO_CONTROL = 18101;
const PUERTO_CONSULTA = 18102;
const CLAVE = "140806";
const estados = [];
const progresos = {};

const ck = crearCashKeeper({
  control: PUERTO_CONTROL,
  consulta: PUERTO_CONSULTA,
  clave: CLAVE,
  ritmo: 400,
  // Lo que mete «el cliente» en cada cobro, según lo que se pide (y en cada cambio, por orden).
  cliente: (_n, { objetivo, recarga, introducido }) => {
    if (objetivo === 750) return [500, 500];
    if (objetivo === 2000) return [500];
    if (objetivo === 1000 && recarga) return [1000];
    if (objetivo === 400) return introducido === 0 ? [200, 200] : [200];
    if (objetivo === 0 && recarga) return [1000, 500];
    if (objetivo === 0) return paraCambiar.shift() ?? [];
    return [];
  },
  cortar: { objetivo: 400, moneda: 1 },
  atasco: 1000,
});
const paraCambiar = [[5000], [2000], [1000]];

const directo = { host: "127.0.0.1", puerto: PUERTO_CONTROL, semilla: CLAVE, modo: "directo", reanudar: false, propina_centimos: 0 };
const ops = [
  { ...directo, id: "op-A", tipo: "cobro", ticket: "1", orden: null, importe_centimos: 700, propina_centimos: 50 },
  { ...directo, id: "op-B", tipo: "prueba", ticket: "2", orden: null, importe_centimos: 0 },
  { ...directo, id: "op-C", tipo: "cobro", ticket: "3", orden: null, importe_centimos: 2000 },
  { ...directo, id: "op-D", tipo: "devolucion", ticket: "4", orden: null, importe_centimos: 300 },
  { ...directo, id: "op-E", tipo: "salida", ticket: "5", orden: null, importe_centimos: 99900 },
  { ...directo, id: "op-F", tipo: "entrada", ticket: "6", orden: null, importe_centimos: 1000 },
  { ...directo, id: "op-G", tipo: "cobro", ticket: "7", orden: null, importe_centimos: 400 },
  { ...directo, id: "op-H", tipo: "entrada", ticket: "8", orden: null, importe_centimos: 0 },
  { ...directo, id: "op-I", tipo: "vaciado", ticket: "9", orden: null, importe_centimos: 0 },
  { ...directo, id: "op-J", tipo: "cambio", ticket: "10", orden: null, importe_centimos: 0 },
  { ...directo, id: "op-K", tipo: "cambio", ticket: "11", orden: null, importe_centimos: 0 },
  { ...directo, id: "op-L", tipo: "cambio", ticket: "12", orden: null, importe_centimos: 0 },
];
// La caja: lo que mete para cambiar y con qué pide el cambio (K, primero con billetes de 10 €, que se atascan).
const metidoParaCambiar = { "op-J": 5000, "op-K": 2000, "op-L": 1000 };
const ultimaFase = {};
let pagosK = 0;
const eleccion = (id) => {
  if (id === "op-J") return [{ valor: 2000, unidades: 2 }, { valor: 500, unidades: 2 }];
  if (id === "op-K") return pagosK === 0 ? [{ valor: 1000, unidades: 2 }] : [{ valor: 500, unidades: 4 }];
  return null;
};
let entregadas = false;

const plataforma = http
  .createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", async () => {
      const enviar = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url === "/v1/agente/latido") {
        return enviar({ agente: { nombre: "PC prueba" }, impresoras: [], cajones_directos: [{ id: "cajon-1", host: "127.0.0.1", puerto: PUERTO_CONTROL, semilla: CLAVE }] });
      }
      if (req.url.startsWith("/v1/agente/trabajos?")) {
        if (!entregadas) {
          entregadas = true;
          return enviar({ ahora: new Date().toISOString(), cajon: ops, trabajos: [] });
        }
        await new Promise((r) => setTimeout(r, 1500));
        return enviar({ ahora: new Date().toISOString(), cajon: [], trabajos: [] });
      }
      const estado = /^\/v1\/agente\/cajon\/([^/]+)\/estado$/.exec(req.url);
      if (estado) {
        const b = JSON.parse(cuerpo);
        estados.push({ id: estado[1], estado: b.estado, error: b.error, resultado: b.resultado });
        if (b.progreso) (progresos[estado[1]] ??= []).push(b.progreso);
        const id = estado[1];
        const fase = b.progreso?.fase;
        if (id === "op-K" && fase === "pagando" && ultimaFase[id] !== "pagando") pagosK++;
        if (fase) ultimaFase[id] = fase;
        const metido = b.progreso?.introducido ?? 0;
        // La caja pide cancelar C en cuanto hay dinero dentro, y L cuando la máquina espera a que se elija el cambio.
        const cancelar = (id === "op-C" && metido > 0) || (id === "op-L" && fase === "eligiendo");
        // Acepta la entrada H cuando ya hay 15 € dentro, confirma el vaciado I y dice «Ya está» al cambiar.
        const terminar =
          (id === "op-H" && metido >= 1500) || (id === "op-I" && fase === "vaciando") || (metidoParaCambiar[id] !== undefined && metido >= metidoParaCambiar[id]);
        const seleccion = fase === "eligiendo" ? eleccion(id) : null;
        return enviar({ estado: b.estado, cancelar, terminar, seleccion });
      }
      res.writeHead(404);
      res.end("{}");
    });
  })
  .listen(3298, "127.0.0.1");

const [ejecutable, argumentos] = programa.endsWith(".mjs") ? [process.execPath, [programa, "--servicio"]] : [programa, ["--servicio"]];
const hijo = spawn(ejecutable, argumentos, {
  env: { ...process.env, TPV_API: "http://127.0.0.1:3298", TPV_AGENTE_TOKEN: "token-prueba", TPV_AGENTE_DATOS: datos },
  stdio: "ignore",
});

const final = (id) => estados.filter((e) => e.id === id && e.estado !== "en_curso").at(-1);
const listo = () => ops.every((o) => final(o.id));
for (let i = 0; i < 300 && !listo(); i++) await new Promise((r) => setTimeout(r, 500));
hijo.kill();
plataforma.close();
ck.cerrar();

const ver = (id) => {
  const f = final(id);
  return f ? `${f.estado}${f.error ? ` (${f.error})` : ""}${f.resultado ? ` ${JSON.stringify(f.resultado)}` : ""}` : "sin acabar";
};
for (const o of ops) console.log(`${o.id.slice(3)} (${o.tipo}):`, ver(o.id));
console.log("Órdenes a la máquina:", ck.maquina.ordenes.join("  "));
const r = (id) => final(id)?.resultado ?? {};
const p = (id) => (progresos[id] ?? []).at(-1) ?? {};
const bien =
  final("op-A")?.estado === "cobrada" &&
  r("op-A").introducido === 1000 &&
  r("op-A").devuelto === 250 &&
  (progresos["op-A"] ?? []).some((p) => p.introducido === 500) &&
  final("op-B")?.estado === "cobrada" &&
  final("op-C")?.estado === "cancelada" &&
  ck.maquina.ordenes.includes("9|1") &&
  final("op-D")?.estado === "cobrada" &&
  r("op-D").devuelto === 300 &&
  final("op-E")?.estado === "error" &&
  /No hay importe suficiente/.test(final("op-E")?.error ?? "") &&
  final("op-F")?.estado === "cobrada" &&
  ck.maquina.ordenes.includes("67") &&
  final("op-G")?.estado === "cobrada" &&
  r("op-G").introducido === 400 &&
  ck.maquina.cortes === 1 &&
  final("op-H")?.estado === "cobrada" &&
  r("op-H").introducido === 1500 &&
  ck.maquina.ordenes.includes("14") &&
  ck.maquina.ordenes.includes("42|1500|1") &&
  ck.maquina.startups >= 2 &&
  // I: vació el cajón de recaudación (lo que había, 120 €) y lo puso a cero.
  final("op-I")?.estado === "cobrada" &&
  p("op-I").devuelto === 12000 &&
  ck.maquina.ordenes.includes("11|5") &&
  (r("op-I").recaudacion ?? []).some((n) => n.valor === 5000 && n.unidades === 2) &&
  // J: 50 € → 2 de 20 € y 2 de 5 €, sin que lo metido cuente para otro cobro.
  final("op-J")?.estado === "cobrada" &&
  p("op-J").introducido === 5000 &&
  p("op-J").devuelto === 5000 &&
  ck.maquina.ordenes.includes("9|0") &&
  ck.maquina.ordenes.includes("52|0") &&
  ck.maquina.ordenes.includes("30|2000,500|2,2|0") &&
  // K: atasco con los de 10 €, se elige otra vez y se da con 4 de 5 €.
  final("op-K")?.estado === "cobrada" &&
  p("op-K").devuelto === 2000 &&
  ck.maquina.ordenes.includes("30|1000|2|0") &&
  ck.maquina.ordenes.includes("30|500|4|0") &&
  // L: cancelado al elegir: la máquina devuelve los 10 €.
  final("op-L")?.estado === "cancelada" &&
  p("op-L").devuelto === 1000 &&
  ck.maquina.ordenes.includes("29|1000|0") &&
  ck.maquina.credito === 0 &&
  // Nunca Terminate (48) ni CloseAll (7): para cerrar basta con soltar la conexión.
  ck.maquina.prohibidas.length === 0;
if (!bien) {
  try {
    console.log("\nRegistro del programa:\n" + fs.readFileSync(path.join(datos, "agente.log"), "utf8"));
  } catch {
    // sin registro
  }
}
console.log(
  bien
    ? "Bien: cobra con vuelta, cancela devolviendo, paga, mete cambio (también sin importe), avisa del error, sigue tras un corte, vacía la recaudación y cambia efectivo."
    : "ALGO FALLA",
);
process.exit(bien ? 0 : 1);
