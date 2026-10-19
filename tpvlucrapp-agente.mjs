#!/usr/bin/env node
// =====================================================================================
// TPV Lucrapp · Agente de impresión (versión 0.2.0)
//
// Un programa pequeño que corre en un ordenador del local (Windows, Mac o Linux) y manda a las
// impresoras de red (ESC/POS, puerto 9100) lo que la caja deja en la cola: comandas, tickets,
// informes de cierre, apertura del cajón y pruebas.
//
//   Lo normal: descargar el programa ya hecho desde la oficina → Impresión y pantallas (Windows o Mac),
//   abrirlo y pegar el código de enlace que da la oficina al crear el agente. Lo guarda en un archivo
//   «agente.json» a su lado y a partir de ahí arranca solo. Déjalo abierto: cada 25 segundos como mucho
//   recoge lo pendiente y la oficina lo ve «en línea».
//
//   Con Node.js (18 o más moderno) también vale:  node tpvlucrapp-agente.mjs
//     (el código por variable de entorno TPV_AGENTE_TOKEN=… o en agente.json {"token": "…"})
//   Probar una impresora sin pasar por la caja:     tpvlucrapp-agente --probar 192.168.1.50:9100
// =====================================================================================
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.0";
const API_POR_DEFECTO = "https://tpvlucrapp-backend-production.up.railway.app";

// Empaquetado como ejecutable, el archivo de configuración va al lado del programa; con Node, al lado del script.
const ejecutable = path.basename(process.execPath ?? "").toLowerCase();
const esPrograma = ejecutable !== "" && !/^(node|bun)(\.exe)?$/.test(ejecutable);
const carpeta = esPrograma ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const archivoConfiguracion = path.join(carpeta, "agente.json");

let configuracion = {};
try {
  configuracion = JSON.parse(fs.readFileSync(archivoConfiguracion, "utf8"));
} catch {
  // sin agente.json: se pregunta (o se usan variables de entorno)
}
const API = String(process.env.TPV_API ?? configuracion.api ?? API_POR_DEFECTO).replace(/\/$/, "");

const hora = () => new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const log = (...partes) => console.log(hora(), ...partes);
const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

function preguntar(texto) {
  const consola = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolver) => consola.question(texto, (respuesta) => { consola.close(); resolver(respuesta.trim()); }));
}

/** Si se abrió con doble clic, que la ventana no desaparezca antes de leer el error. */
async function salir(codigo, mensaje) {
  if (mensaje) console.error(mensaje);
  if (esPrograma && process.stdin.isTTY) await preguntar("\nPulsa Enter para cerrar.");
  process.exit(codigo);
}

/** Manda bytes a una impresora de red y espera a que cierre la conexión. */
function imprimir(direccion, puerto, datos) {
  return new Promise((resolver, rechazar) => {
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

/** El código de enlace: variable de entorno, agente.json o se pide por pantalla y se guarda. */
async function obtenerToken() {
  if (process.env.TPV_AGENTE_TOKEN) return process.env.TPV_AGENTE_TOKEN;
  if (configuracion.token) return configuracion.token;
  if (!process.stdin.isTTY) return null;
  console.log("TPV Lucrapp · Agente de impresión " + VERSION);
  console.log("Primera vez: en la oficina → Impresión y pantallas → Agente de impresión → «Nuevo agente», copia el código de enlace.");
  const token = await preguntar("Pega aquí el código de enlace y pulsa Enter: ");
  if (!token) return null;
  try {
    fs.writeFileSync(archivoConfiguracion, JSON.stringify({ token, api: API }, null, 2));
    console.log(`Guardado en ${archivoConfiguracion}. La próxima vez arranca solo.`);
  } catch (error) {
    console.log(`No se pudo guardar agente.json (${error.message}): habrá que pegar el código cada vez.`);
  }
  return token;
}

if (process.argv[2] === "--probar") {
  const [direccion, puerto = "9100"] = String(process.argv[3] ?? "").split(":");
  if (!direccion) {
    await salir(1, "Uso: tpvlucrapp-agente --probar 192.168.1.50:9100");
  }
  // Prueba mínima en ESC/POS: inicializar, texto, avance y corte.
  const prueba = Buffer.concat([
    Buffer.from([0x1b, 0x40, 0x1b, 0x61, 1, 0x1b, 0x45, 1]),
    Buffer.from("TPV LUCRAPP\n", "latin1"),
    Buffer.from([0x1b, 0x45, 0]),
    Buffer.from(`Prueba directa del agente ${VERSION}\n${new Date().toLocaleString("es-ES")}\n\n\n`, "latin1"),
    Buffer.from([0x1d, 0x56, 66, 0]),
  ]);
  try {
    await imprimir(direccion, puerto, prueba);
    log(`✓ Enviado a ${direccion}:${puerto}. Si no salió nada, revisa la IP y que la impresora acepte RAW/9100.`);
    await salir(0);
  } catch (error) {
    await salir(1, `✗ ${error.message}`);
  }
} else {
  const TOKEN = await obtenerToken();
  if (!TOKEN) {
    await salir(1, "Falta el código de enlace del agente: pégalo al abrir el programa, o TPV_AGENTE_TOKEN=… / agente.json {\"token\": \"…\"}.");
  }
  const cabeceras = { authorization: `Bearer ${TOKEN}`, "x-agente-version": VERSION, "content-type": "application/json" };

  async function api(metodo, ruta, cuerpo) {
    const respuesta = await fetch(`${API}/v1/agente${ruta}`, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    if (!respuesta.ok) {
      const texto = await respuesta.text().catch(() => "");
      throw new Error(`${metodo} ${ruta} → ${respuesta.status} ${texto.slice(0, 200)}`);
    }
    return respuesta.json();
  }

  async function procesar(trabajo) {
    const datos = Buffer.from(trabajo.datos, "base64");
    if (!trabajo.impresora.direccion) throw new Error("la impresora no tiene dirección");
    for (let copia = 0; copia < (trabajo.copias ?? 1); copia++) {
      await imprimir(trabajo.impresora.direccion, trabajo.impresora.puerto, datos);
    }
  }

  async function bucle() {
    log(`Agente de impresión ${VERSION} · ${API}`);
    let fallosSeguidos = 0;
    try {
      const latido = await api("POST", "/latido", { version: VERSION });
      const lista = latido.impresoras.map((i) => `${i.nombre} (${i.direccion}:${i.puerto})`).join(", ");
      log(`Conectado como «${latido.agente.nombre}». Impresoras: ${lista || "ninguna asignada todavía"}`);
      log("Deja esta ventana abierta: las comandas y los tickets saldrán solos.");
    } catch (error) {
      if (/→ 401/.test(error.message)) {
        try {
          fs.unlinkSync(archivoConfiguracion);
        } catch {
          // no había archivo
        }
        await salir(1, "La plataforma no reconoce ese código de enlace (¿renovado o borrado en la oficina?). Vuelve a abrir el programa y pega el nuevo.");
      }
      log(`No se pudo conectar: ${error.message}. Se vuelve a intentar.`);
    }
    for (;;) {
      try {
        const { trabajos } = await api("GET", "/trabajos?espera=25");
        fallosSeguidos = 0;
        for (const trabajo of trabajos) {
          try {
            await procesar(trabajo);
            await api("POST", `/trabajos/${trabajo.id}/resultado`, { estado: "impreso" });
            log(`✓ ${trabajo.titulo} → ${trabajo.impresora.nombre}`);
          } catch (error) {
            const mensaje = String(error.message ?? error).slice(0, 300);
            await api("POST", `/trabajos/${trabajo.id}/resultado`, { estado: "error", error: mensaje }).catch(() => {});
            log(`✗ ${trabajo.titulo} → ${trabajo.impresora.nombre}: ${mensaje}`);
          }
        }
      } catch (error) {
        fallosSeguidos++;
        log(`Error: ${error.message}`);
        await dormir(Math.min(5000 * fallosSeguidos, 60_000));
      }
    }
  }

  bucle();
}
