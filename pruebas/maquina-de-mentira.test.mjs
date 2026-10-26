// La máquina de mentira (la de arrancar-local.sh y la app Palomitas) frente al programa de verdad: cada flujo de dinero de
// la caja tiene que acabar bien, sin «pendiente de conciliación». Si el programa empieza a pedir algo nuevo a la máquina
// (como la 43 con el crédito o la 87 al pagar piezas), esta prueba avisa antes de que falle probando en local.
//   node --test pruebas/maquina-de-mentira.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.TPV_AGENTE_DATOS = fs.mkdtempSync(path.join(os.tmpdir(), "ck-mentira-"));
const { crearCashKeeper } = await import("./cashkeeper-de-mentira.mjs");
const { MaquinaDirecta, operarDirecto } = await import("../tpvlucrapp-agente.mjs");
const { DiarioCashKeeper } = await import("../cashkeeper-seguro.mjs");

const CONTROL = 18301;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ck;
let m;
let diario;
/** Lo que mete «el cliente» en cada Totalize o Enable (lo cambia cada caso). */
let monedas = () => [];

before(() => {
  ck = crearCashKeeper({ control: CONTROL, consulta: CONTROL + 1, cliente: (n, datos) => monedas(datos), ritmo: 15 });
  m = new MaquinaDirecta("127.0.0.1", CONTROL, "100001");
  m.intervalo = 40;
  diario = new DiarioCashKeeper(path.join(process.env.TPV_AGENTE_DATOS, "ops"));
});
after(() => {
  m.soltar();
  ck.cerrar();
  fs.rmSync(process.env.TPV_AGENTE_DATOS, { recursive: true, force: true });
});

/** Lleva una operación como la caja: `responder` contesta a cada «en curso» (terminar, cancelar, elegir piezas…). */
async function operar(datos, responder = () => null) {
  const op = { id: randomUUID(), host: "127.0.0.1", puerto: CONTROL, semilla: "100001", propina_centimos: 0, ...datos };
  let final = null;
  await operarDirecto(
    op,
    async (estado, error, resultado, progreso) => {
      if (estado !== "en_curso") final = { estado, error, resultado, progreso };
      return estado === "en_curso" ? responder(progreso ?? {}, resultado) : null;
    },
    { maquina: m, diario },
  );
  await dormir(30);
  return final;
}
const bien = (final, estado = "cobrada") => {
  assert.equal(final?.error ?? null, null, `acabó con error: ${final?.error}`);
  assert.equal(final?.estado, estado);
  assert.notEqual(final?.resultado?.conciliar, true);
  assert.equal(ck.maquina.estado, 1, "la máquina vuelve a reposo");
  assert.equal(ck.maquina.credito, 0, "sin crédito pendiente");
};

test("cobro con vuelta: 12,50 € con 10 + 5 €", async () => {
  monedas = () => [1000, 500];
  const f = await operar({ tipo: "cobro", importe_centimos: 1250 });
  bien(f);
  assert.equal(f.progreso.introducido, 1500);
  assert.equal(f.progreso.devuelto, 250);
});

test("cobro exacto: 3 € con 2 + 1 €", async () => {
  monedas = () => [200, 100];
  bien(await operar({ tipo: "cobro", importe_centimos: 300 }));
});

test("cobro cancelado a medias: devuelve lo metido", async () => {
  monedas = () => [500];
  const f = await operar({ tipo: "cobro", importe_centimos: 1000 }, (p) => (p.introducido === 500 ? { cancelar: true } : null));
  bien(f, "cancelada");
  assert.equal(f.progreso.devuelto, 500);
});

test("entrada sin importe: meter cambio y «Ya está» (usa la 43 tras parar sin devolver)", async () => {
  monedas = () => [2000, 500];
  const f = await operar({ tipo: "entrada", importe_centimos: 0 }, (p) => (p.introducido === 2500 ? { terminar: true } : null));
  bien(f);
  assert.equal(f.progreso.introducido, 2500);
});

test("entrada con importe: 50 €", async () => {
  monedas = ({ objetivo }) => (objetivo === 5000 ? [2000, 2000, 1000] : []);
  bien(await operar({ tipo: "entrada", importe_centimos: 5000 }));
});

test("salida de 7,50 € (29)", async () => {
  const f = await operar({ tipo: "salida", importe_centimos: 750 });
  bien(f);
  assert.equal(f.progreso.devuelto, 750);
});

test("salida eligiendo piezas: 10 € + 5 € (87)", async () => {
  bien(await operar({ tipo: "salida", importe_centimos: 1500, seleccion: [{ valor: 1000, unidades: 1 }, { valor: 500, unidades: 1 }] }));
});

test("devolución de 4,20 €", async () => {
  bien(await operar({ tipo: "devolucion", importe_centimos: 420 }));
});

test("cambiar efectivo: meten 73 € y se dan 2 × 20 + 3 × 10 + 2 + 1 (el caso del 26-10)", async () => {
  monedas = () => [5000, 2000, 200, 100];
  const f = await operar({ tipo: "cambio", importe_centimos: 0 }, (p) => {
    if (p.fase === "eligiendo") return { seleccion: [{ valor: 2000, unidades: 2 }, { valor: 1000, unidades: 3 }, { valor: 200, unidades: 1 }, { valor: 100, unidades: 1 }] };
    return p.introducido === 7300 && p.fase === "metiendo" ? { terminar: true } : null;
  });
  bien(f);
  assert.equal(f.progreso.introducido, 7300);
  assert.equal(f.progreso.devuelto, 7300);
});

test("retirar la recaudación (11)", async () => {
  bien(await operar({ tipo: "vaciado", importe_centimos: 0, vaciar: "todo" }, () => ({ terminar: true })));
  assert.equal(ck.totalRecaudacion(), 0);
});

test("vaciar los recicladores de monedas (12)", async () => {
  bien(await operar({ tipo: "mantenimiento", importe_centimos: 0, herramienta: { accion: "recicladores", dispositivo: "monedas", confirmado: true } }));
});

test("fondo al cierre: dejar 5 billetes de 10 € (13)", async () => {
  bien(await operar({ tipo: "mantenimiento", importe_centimos: 0, herramienta: { accion: "cierre", conservar: [{ valor: 1000, unidades: 5 }], confirmado: true } }));
  assert.equal(ck.maquina.cambio[1000], 5);
});

test("diagnóstico y niveles", async () => {
  const d = await operar({ tipo: "mantenimiento", importe_centimos: 0, herramienta: { accion: "diagnostico" } });
  assert.equal(d.estado, "cobrada");
  assert.equal(d.resultado.conciliar, false);
  const n = await operar({ tipo: "mantenimiento", importe_centimos: 0, herramienta: { accion: "niveles" } });
  assert.equal(n.estado, "cobrada");
});
