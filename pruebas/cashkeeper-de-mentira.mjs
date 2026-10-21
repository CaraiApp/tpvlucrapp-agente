// Un CashKeeper de mentira: habla como la máquina por su conexión de control (Host, la que usa el programa sin
// CKMonitor) y por la de consulta (Office). Para probar el programa sin máquina: en las pruebas automáticas
// (pruebas/directo.mjs) y en local, metiendo «monedas» con el teclado.
//   node pruebas/cashkeeper-de-mentira.mjs [--control 8001] [--consulta 8002] [--clave 100001]
// En la ventana: 1 y 2 meten monedas de 1 y 2 €; 5, 0, v y c, billetes de 5, 10, 20 y 50 €; q sale.
// Sigue el manual del integrador (§7, §8 y anexo 9.2): clave con 47/57/58, 39 Startup, 40 State, 42 Totalize, 9 Disable,
// 29 Pay, 14 Enable, 43 ValueIN, 67 ActivateRefillMode, 52 DiscardOperation, 68 DiscardPayOperation, y los avisos 100 Disabled,
// 104 ProcessInterrupted, 106 StateChange, 107 ValueIN y 108 ValueOUT. Las cantidades van en céntimos.
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DENOMINACIONES = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

export function crearCashKeeper(opciones = {}) {
  const {
    control = 8001,
    consulta = 8002,
    clave = "100001",
    numero = 1620168189,
    // Lo que mete «el cliente» en cada Totalize o Enable: (n, { objetivo, recarga }) => [valores] (en céntimos), uno cada `ritmo` ms.
    cliente = null,
    ritmo = 200,
    // Simula un corte de la conexión de control al meter la moneda número `moneda` de un cobro de `objetivo` (una vez).
    cortar = null,
    fondo = 30000,
    contar = () => {},
  } = opciones;

  const m = {
    estado: 0,
    objetivo: 0,
    introducido: 0,
    autoclose: true,
    recarga: false,
    interrumpida: null,
    cliente: null,
    fondo,
    recaudacion: 0,
    totalizes: 0,
    ordenes: [],
    prohibidas: [],
    startups: 0,
    cortes: 0,
  };
  let temporizador = null;
  let monedasDeEsta = 0;

  const mandar = (socket, texto) => socket && !socket.destroyed && socket.write(Buffer.from(texto, "latin1"));
  const avisar = (texto) => mandar(m.cliente, texto);
  const cambiarEstado = (nuevo) => {
    const antes = m.estado;
    m.estado = nuevo;
    avisar(`$106|${nuevo}|${antes}#`);
  };

  /** Acaba lo que estaba haciendo: la vuelta (si hay) y el aviso 100 Disabled. */
  function terminarCobro({ devolverTodo = false } = {}) {
    clearInterval(temporizador);
    const metido = m.introducido;
    const vuelta = devolverTodo ? metido : Math.max(0, metido - m.objetivo);
    if (vuelta > 0) {
      cambiarEstado(3);
      avisar(`$108|${Math.round(vuelta / 2)}|${vuelta}|0#`);
      avisar(`$108|${vuelta}|${vuelta}|0#`);
    }
    const objetivo = m.objetivo;
    if (!devolverTodo) {
      if (m.recarga) m.fondo += metido - vuelta;
      else m.recaudacion += metido - vuelta;
    }
    m.introducido = 0;
    m.objetivo = 0;
    m.recarga = false;
    avisar(`$100|0||${metido}|${objetivo}|2|0#`);
    cambiarEstado(1);
  }

  /** «El cliente» mete una moneda o un billete. */
  function meter(valor) {
    if (m.estado !== 2) return false;
    monedasDeEsta++;
    cambiarEstado(7);
    m.introducido += valor;
    avisar(`$107|${m.introducido}|${m.objetivo}|0#`);
    if (cortar && cortar.objetivo === m.objetivo && cortar.moneda === monedasDeEsta && !cortar.hecho) {
      // Se corta la conexión con el programa: la máquina se cierra y guarda lo que estaba haciendo.
      cortar.hecho = true;
      m.cortes++;
      m.interrumpida = { estado: 2, valor: m.introducido, objetivo: m.objetivo };
      clearInterval(temporizador);
      m.cliente?.destroy();
      return true;
    }
    cambiarEstado(2);
    if (m.autoclose && m.introducido >= m.objetivo) terminarCobro();
    return true;
  }

  function empezarCliente() {
    clearInterval(temporizador);
    if (!cliente) return;
    const monedas = [...(cliente(m.totalizes, { objetivo: m.objetivo, recarga: m.recarga, introducido: m.introducido }) ?? [])];
    temporizador = setInterval(() => {
      const valor = monedas.shift();
      if (valor === undefined || m.estado !== 2) return clearInterval(temporizador);
      meter(valor);
    }, ritmo);
  }

  function atenderControl(socket, codigo, p) {
    m.ordenes.push([codigo, ...p].join("|"));
    const responder = (texto) => mandar(socket, texto);
    switch (codigo) {
      case "39": {
        if (m.estado !== 0) return responder("$39|0|49|El dispositivo ya está inicializado#");
        m.startups++;
        // Si se cortó a medias, lo avisa al arrancar (y conserva lo metido para seguir).
        if (m.interrumpida) {
          const i = m.interrumpida;
          responder(`$104|${i.estado}|${i.valor}|${i.objetivo}|0#`);
          m.introducido = i.valor;
          m.objetivo = i.objetivo;
          m.interrumpida = null;
        }
        responder("$39|1|0|0|0|0|0|0|0|1000|0|10|0|0|0|0|0|0|0|0|10|0|0|0#");
        return cambiarEstado(1);
      }
      case "40":
        return responder(`$40|1|${m.estado}#`);
      case "42": {
        if (![1, 2, 7].includes(m.estado)) return responder("$42|0|2|Dispositivo ocupado. No se puede procesar el comando#");
        m.totalizes++;
        monedasDeEsta = 0;
        m.objetivo = Number(p[0]) || 0;
        m.autoclose = p[1] !== "0";
        responder("$42|1#");
        if (m.objetivo === 0) {
          // Totalize(0): devolver lo pendiente.
          if (m.estado === 1) cambiarEstado(2);
          return terminarCobro({ devolverTodo: true });
        }
        if (m.estado === 1) cambiarEstado(2);
        if (m.autoclose && m.introducido >= m.objetivo) return terminarCobro();
        return empezarCliente();
      }
      case "14": {
        // Enable: acepta dinero sin importe (hasta un Totalize o un Disable).
        if (m.estado !== 1) return responder("$14|0|2|Dispositivo ocupado. No se puede procesar el comando#");
        m.objetivo = 0;
        m.autoclose = false;
        monedasDeEsta = 0;
        responder("$14|1#");
        cambiarEstado(2);
        return empezarCliente();
      }
      case "43":
        return responder(`$43|1|${m.introducido}#`);
      case "9": {
        if (m.estado !== 2 && m.estado !== 7) return responder("$9|0|36|El dispositivo no está habilitado. No se puede procesar el comando#");
        responder("$9|1#");
        return terminarCobro({ devolverTodo: p[0] === "1" });
      }
      case "29": {
        const valor = Number(p[0]) || 0;
        if (m.estado !== 1) return responder("$29|0|2|Dispositivo ocupado. No se puede procesar el comando#");
        if (valor > m.fondo) return responder("$29|0|32|No hay importe suficiente para realizar el pago#");
        responder("$29|1#");
        if (p[1] === "1") return;
        cambiarEstado(3);
        avisar(`$108|${Math.round(valor / 2)}|${valor}|0#`);
        avisar(`$108|${valor}|${valor}|0#`);
        m.fondo -= valor;
        avisar(`$100|0||${valor}|${valor}|3|0#`);
        return cambiarEstado(1);
      }
      case "67":
        m.recarga = true;
        return responder("$67|1#");
      case "52":
        m.introducido = 0;
        return responder("$52|1#");
      case "68":
        return responder("$68|1#");
      case "48":
      case "7":
        m.prohibidas.push(codigo);
        responder(`$${codigo}|1#`);
        return socket.destroy();
      default:
        return responder(`$${codigo}|0|42|Se produjo un error inesperado al ejecutar el comando#`);
    }
  }

  function atenderConsulta(socket, codigo) {
    const responder = (texto) => mandar(socket, texto);
    if (codigo === "79") {
      const unidades = DENOMINACIONES.map((v) => (v >= 500 ? 2 : 10));
      return responder(`$79|1|${DENOMINACIONES.join(",")}|${unidades.join(",")}|${DENOMINACIONES.map(() => "EUR").join(",")}#`);
    }
    if (codigo === "17") return responder(`$17|1|EUR|500,1000,2000,5000|${Math.floor(m.recaudacion / 500)},0,0,0#`);
    return responder(`$${codigo}|0|42|Orden no esperada#`);
  }

  function servidor(puerto, esControl) {
    return net
      .createServer((socket) => {
        // La conexión de control tiene un solo dueño (si no, sería CKMonitor y el programa a la vez).
        if (esControl && m.cliente && !m.cliente.destroyed) return socket.destroy();
        let pendiente = "";
        let dentro = false;
        socket.setEncoding("latin1");
        if (esControl) m.cliente = socket;
        socket.on("data", (trozo) => {
          pendiente += trozo;
          for (let fin = pendiente.indexOf("#"); fin >= 0; fin = pendiente.indexOf("#")) {
            const mensaje = pendiente.slice(pendiente.indexOf("$") + 1, fin);
            pendiente = pendiente.slice(fin + 1);
            const [codigo, ...p] = mensaje.split("|");
            if (codigo === "47") {
              mandar(socket, `$57|${numero}#`);
              continue;
            }
            if (codigo === "57" && !dentro) {
              if (Number(p[0]) !== numero + Number(clave)) return socket.destroy();
              dentro = true;
              mandar(socket, "$58|5#");
              continue;
            }
            if (!dentro) return socket.destroy();
            if (esControl) atenderControl(socket, codigo, p);
            else atenderConsulta(socket, codigo);
          }
        });
        socket.on("close", () => {
          if (!esControl || m.cliente !== socket) return;
          // Sin su dueño, la máquina se cierra (y guarda lo que hacía a medias).
          clearInterval(temporizador);
          if ((m.estado === 2 || m.estado === 7) && !m.interrumpida) m.interrumpida = { estado: 2, valor: m.introducido, objetivo: m.objetivo };
          m.estado = 0;
          m.cliente = null;
        });
        socket.on("error", () => {});
      })
      .listen(puerto, "127.0.0.1");
  }

  const servidores = [servidor(control, true), servidor(consulta, false)];
  contar(`CashKeeper de mentira: control en 127.0.0.1:${control}, consulta en 127.0.0.1:${consulta}, clave ${clave}`);
  return {
    maquina: m,
    meter,
    cerrar() {
      clearInterval(temporizador);
      m.cliente?.destroy();
      for (const s of servidores) s.close();
    },
  };
}

// En la ventana (para probar en local): meter monedas y billetes con el teclado.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (nombre, defecto) => {
    const i = process.argv.indexOf(`--${nombre}`);
    return i > 0 ? process.argv[i + 1] : defecto;
  };
  const ck = crearCashKeeper({
    control: Number(arg("control", 8001)),
    consulta: Number(arg("consulta", 8002)),
    clave: arg("clave", "100001"),
    contar: console.log,
  });
  const teclas = { 1: 100, 2: 200, 5: 500, 0: 1000, v: 2000, c: 5000 };
  const euros = (c) => `${(c / 100).toFixed(2).replace(".", ",")} €`;
  console.log("Teclas: 1 y 2 = monedas de 1 y 2 €; 5, 0, v y c = billetes de 5, 10, 20 y 50 €; q = salir.");
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (tecla) => {
    if (tecla === "q" || tecla === "\u0003") {
      ck.cerrar();
      process.exit(0);
    }
    const valor = teclas[tecla];
    if (!valor) return;
    if (ck.meter(valor)) console.log(`Metido ${euros(valor)} → llevo ${euros(ck.maquina.introducido)} de ${euros(ck.maquina.objetivo)}`);
    else console.log("La máquina no está esperando dinero ahora (pide un cobro desde la caja).");
  });
  setInterval(() => {}, 1 << 30);
}
