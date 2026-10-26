// Un CashKeeper de mentira: habla como la máquina por su conexión de control (Host, la que usa el programa sin
// CKMonitor) y por la de consulta (Office). Para probar el programa sin máquina: en las pruebas automáticas
// (pruebas/directo.mjs) y en local, metiendo «monedas» con el teclado.
//   node pruebas/cashkeeper-de-mentira.mjs [--control 8001] [--consulta 8002] [--clave 100001]
// En la ventana: 1 y 2 meten monedas de 1 y 2 €; 5, 0, v y c, billetes de 5, 10, 20 y 50 €; n enseña lo que tiene;
// f hace fallar el siguiente vaciado de recicladores o cierre por niveles (error 42, sin mover nada); q sale.
// Sigue el manual del integrador (§7, §8 y anexo 9.2): clave con 47/57/58, 39 Startup, 40 State, 42 Totalize, 9 Disable,
// 29 Pay, 30 PaySpecific, 87 PaySpecificEx, 14 Enable, 43 ValueIN, 67 ActivateRefillMode, 52 DiscardOperation, 68 DiscardPayOperation,
// 11 EmptyCashBox, 17 GetCashBoxLevel, 79 GetLastLevels, 38 la divisa, 19 unidades, 44 ValueOUT, 45 ValueToCashBox,
// 12 EmptyDevice (recicladores a recaudación), 13 por niveles (fondo al cierre), 78 denominaciones, 21/36 aceptación, y los
// avisos 100 Disabled, 104 ProcessInterrupted, 106 StateChange, 107 ValueIN, 108 ValueOUT y 109 ValueToCashBox. Los
// ajustes del manual (propiedades, máximos y mínimos, firmware…) no los imita. Las cantidades van en céntimos. Lleva la
// cuenta de cada moneda y billete:
// lo que hay para dar cambio (recicladores) y en el cajón de recaudación (los billetes de 50 € van ahí).
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const DENOMINACIONES = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
/** Lo que tiene al empezar para dar cambio (unidades de cada valor) y en el cajón de recaudación. */
export const CAMBIO_DE_SERIE = { 5: 20, 10: 20, 20: 20, 50: 20, 100: 20, 200: 20, 500: 10, 1000: 10, 2000: 5, 5000: 0 };
export const RECAUDACION_DE_SERIE = { 100: 5, 200: 3, 2000: 1, 5000: 2 };
const total = (unidades) => Object.entries(unidades).reduce((suma, [valor, n]) => suma + Number(valor) * n, 0);

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
    // Lo que tiene para dar cambio y en el cajón de recaudación: { valor: unidades }.
    cambio = CAMBIO_DE_SERIE,
    recaudacion = RECAUDACION_DE_SERIE,
    // Simula un atasco (una vez) al pagar con PaySpecific las unidades de este valor: no salen y acaba con error.
    atasco = null,
    contar = () => {},
    // Cada mensaje y cada conexión, para enseñarlos (el panel de palomitas): (sentido «entra» | «sale» | «conexion», texto, «control» | «consulta»).
    traza = () => {},
  } = opciones;

  const m = {
    estado: 0,
    objetivo: 0,
    introducido: 0,
    autoclose: true,
    recarga: false,
    interrumpida: null,
    cliente: null,
    cambio: Object.fromEntries(DENOMINACIONES.map((v) => [v, cambio[v] ?? 0])),
    recaudacion: Object.fromEntries(DENOMINACIONES.map((v) => [v, recaudacion[v] ?? 0])),
    // Lo metido en esta operación (para devolver lo mismo si se cancela) y el crédito que dejó un Disable sin devolver.
    metidas: [],
    credito: 0,
    // Lo último que pagó (44 ValueOUT), lo último que pasó del cambio a recaudación (45) y qué valores acepta (21/36).
    ultimaSalida: 0,
    transferido: 0,
    aceptacion: Object.fromEntries(DENOMINACIONES.map((v) => [v, 0])),
    atascada: false,
    totalizes: 0,
    ordenes: [],
    prohibidas: [],
    startups: 0,
    cortes: 0,
  };
  let temporizador = null;
  let monedasDeEsta = 0;

  const mandar = (socket, texto) => {
    if (!socket || socket.destroyed) return false;
    traza("sale", texto, socket === m.cliente ? "control" : "consulta");
    return socket.write(Buffer.from(texto, "latin1"));
  };
  const avisar = (texto) => mandar(m.cliente, texto);
  const cambiarEstado = (nuevo) => {
    const antes = m.estado;
    m.estado = nuevo;
    avisar(`$106|${nuevo}|${antes}#`);
  };

  /** Monedas y billetes para pagar `importe` con lo que hay para dar cambio (de mayor a menor), o null si no se puede. */
  function piezasPara(importe) {
    const piezas = [];
    let falta = importe;
    for (const valor of [...DENOMINACIONES].reverse()) {
      let quedan = m.cambio[valor];
      while (falta >= valor && quedan > 0) {
        piezas.push(valor);
        falta -= valor;
        quedan--;
      }
    }
    return falta === 0 ? piezas : null;
  }

  /** Saca esas piezas de la máquina, avisando de lo que sale (108 ValueOUT). */
  function pagarPiezas(piezas, objetivo) {
    let pagado = 0;
    for (const valor of piezas) {
      m.cambio[valor]--;
      pagado += valor;
      avisar(`$108|${pagado}|${objetivo}|0#`);
    }
    m.ultimaSalida = pagado;
    return pagado;
  }

  /** Lo metido se queda en la máquina: al cambio (o, los billetes de 50 € fuera del modo de llenado, a recaudación). */
  function guardarMetidas() {
    for (const valor of m.metidas) {
      if (valor >= 5000 && !m.recarga) m.recaudacion[valor]++;
      else m.cambio[valor]++;
    }
    m.metidas = [];
  }

  /** Acaba lo que estaba haciendo: la vuelta (si hay) y el aviso 100 Disabled. Sin `aceptar`, lo metido queda de crédito. */
  function terminarCobro({ devolverTodo = false, quedarse = false } = {}) {
    clearInterval(temporizador);
    const metido = m.introducido;
    const objetivo = m.objetivo;
    if (devolverTodo) {
      // Devuelve lo mismo que se metió (y, si había crédito de antes, lo que falte, con lo que tenga).
      cambiarEstado(3);
      let pagado = 0;
      for (const valor of m.metidas) {
        pagado += valor;
        avisar(`$108|${pagado}|${metido}|0#`);
      }
      m.metidas = [];
      const resto = metido - pagado;
      if (resto > 0) pagado += pagarPiezas(piezasPara(resto) ?? [], metido);
      m.ultimaSalida = pagado;
    } else {
      guardarMetidas();
      if (quedarse) m.credito = metido;
      const vuelta = quedarse ? 0 : Math.max(0, metido - objetivo);
      if (vuelta > 0) {
        cambiarEstado(3);
        pagarPiezas(piezasPara(vuelta) ?? [], vuelta);
      }
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
    m.metidas.push(valor);
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
        // El crédito que dejó un Disable sin devolver cuenta para este cobro si no se descartó (52 DiscardOperation).
        if (m.estado === 1 && m.credito > 0) {
          m.introducido += m.credito;
          m.credito = 0;
        }
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
        // GetValueIN: el crédito de la operación. Mientras acepta dinero, lo metido; tras un Disable sin devolver (9|0), lo
        // que se quedó, hasta que el programa lo olvide con 52 DiscardOperation (como la máquina real: el programa lo
        // comprueba al aceptar una entrada sin importe y al cambiar efectivo).
        return responder(`$43|1|${m.estado === 2 || m.estado === 7 ? m.introducido : m.credito}#`);
      case "9": {
        if (m.estado !== 2 && m.estado !== 7) return responder("$9|0|36|El dispositivo no está habilitado. No se puede procesar el comando#");
        responder("$9|1#");
        // Payback 1: devuelve lo metido; 0: se lo queda (como crédito de la operación, hasta un 52 DiscardOperation).
        return p[0] === "1" ? terminarCobro({ devolverTodo: true }) : terminarCobro({ quedarse: true });
      }
      case "29": {
        const valor = Number(p[0]) || 0;
        if (m.estado !== 1) return responder("$29|0|2|Dispositivo ocupado. No se puede procesar el comando#");
        const piezas = piezasPara(valor);
        if (!piezas) return responder("$29|0|32|No hay importe suficiente para realizar el pago#");
        responder("$29|1#");
        if (p[1] === "1") return;
        cambiarEstado(3);
        pagarPiezas(piezas, valor);
        avisar(`$100|0||${valor}|${valor}|3|0#`);
        return cambiarEstado(1);
      }
      case "30":
      case "87": {
        // PaySpecific (30) y PaySpecificEx (87, la salida eligiendo piezas): valores y unidades separados por comas, y si es
        // solo una prueba.
        if (m.estado !== 1) return responder(`$${codigo}|0|2|Dispositivo ocupado. No se puede procesar el comando#`);
        const valores = String(p[0] ?? "").split(",").map(Number);
        const unidades = String(p[1] ?? "").split(",").map(Number);
        if (valores.length !== unidades.length || valores.some((v, i) => !(m.cambio[v] >= unidades[i]) || !(unidades[i] > 0))) {
          return responder(`$${codigo}|0|32|No hay importe suficiente para realizar el pago#`);
        }
        responder(`$${codigo}|1#`);
        if (p[2] === "1") return;
        const pedido = valores.reduce((suma, v, i) => suma + v * unidades[i], 0);
        cambiarEstado(3);
        const piezas = valores.flatMap((v, i) => Array(unidades[i]).fill(v));
        const atascada = atasco !== null && !m.atascada && valores.includes(atasco);
        if (atascada) m.atascada = true;
        const pagado = pagarPiezas(atascada ? piezas.filter((v) => v !== atasco) : piezas, pedido);
        avisar(atascada ? `$100|12|Atasco en la salida de billetes|${pagado}|${pedido}|3|0#` : `$100|0||${pagado}|${pedido}|3|0#`);
        return cambiarEstado(1);
      }
      case "11": {
        // EmptyCashBox: pone a cero el cajón de recaudación (1 monedas, 2 billetes, 5 todo).
        if (m.estado !== 1) return responder("$11|0|2|Dispositivo ocupado. No se puede procesar el comando#");
        const cual = Number(p[0]) || 5;
        for (const v of DENOMINACIONES) if (cual === 5 || (cual === 1 && v < 500) || (cual === 2 && v >= 500)) m.recaudacion[v] = 0;
        return responder("$11|1#");
      }
      case "17":
      case "79":
        return responder(niveles(codigo));
      case "67":
        m.recarga = true;
        return responder("$67|1#");
      case "52":
        m.introducido = 0;
        m.credito = 0;
        return responder("$52|1#");
      case "68":
        return responder("$68|1#");
      case "48":
      case "7":
        m.prohibidas.push(codigo);
        responder(`$${codigo}|1#`);
        return socket.destroy();
      case "38":
      case "19":
      case "78":
        // La divisa, las unidades y las denominaciones también se preguntan por la de control (antes de mover dinero, desde el 0.7.0).
        return atenderConsulta(socket, codigo, p);
      case "44":
        return responder(`$44|1|${m.ultimaSalida}#`);
      case "45":
        return responder(`$45|1|${m.transferido}#`);
      case "12":
      case "13": {
        // 12 EmptyDevice (1 monedas, 2 billetes, 5 todo) y 13 por niveles (valores y unidades que se quedan): lo que sale de
        // los recicladores pasa al cajón de recaudación, avisando con 109 ValueToCashBox y al final 100 Disabled.
        if (m.estado !== 1) return responder(`$${codigo}|0|2|Dispositivo ocupado. No se puede procesar el comando#`);
        // Tecla f: para probar la incidencia de un vaciado que falla (la máquina lo rechaza y no mueve nada).
        if (m.fallarVaciado) {
          m.fallarVaciado = false;
          return responder(`$${codigo}|0|42|Se produjo un error inesperado al ejecutar el comando#`);
        }
        const cual = Number(p[0]) || 5;
        const quedan = {};
        if (codigo === "13") {
          const unidades = String(p[1] ?? "").split(",").map(Number);
          String(p[0] ?? "").split(",").forEach((v, i) => { quedan[Number(v)] = unidades[i] || 0; });
        }
        responder(`$${codigo}|1#`);
        const estado = codigo === "12" ? 5 : 4;
        cambiarEstado(estado);
        const salen = DENOMINACIONES.map((v) => [v, codigo === "12" && !(cual === 5 || (cual === 1 && v < 500) || (cual === 2 && v >= 500)) ? 0 : m.cambio[v] - Math.min(m.cambio[v], quedan[v] ?? 0)]);
        const objetivo = salen.reduce((suma, [v, n]) => suma + v * n, 0);
        m.transferido = 0;
        for (const [v, n] of salen) {
          if (n <= 0) continue;
          m.cambio[v] -= n;
          m.recaudacion[v] += n;
          m.transferido += n * v;
          avisar(`$109|${m.transferido}|${objetivo}|0#`);
        }
        avisar(`$100|0||${m.transferido}|${m.transferido}|${estado}|0#`);
        return cambiarEstado(1);
      }
      case "21":
        return responder(`$21|1|${String(p[1] ?? "").split(",").map((v) => m.aceptacion[Number(v)] ?? 0).join(",")}#`);
      case "36": {
        const estados = String(p[2] ?? "").split(",").map(Number);
        String(p[1] ?? "").split(",").forEach((v, i) => { if (Number(v) in m.aceptacion) m.aceptacion[Number(v)] = estados[i] || 0; });
        return responder("$36|1#");
      }
      default:
        return responder(`$${codigo}|0|42|Se produjo un error inesperado al ejecutar el comando#`);
    }
  }

  /** Lo que tiene: 79 GetLastLevels (para dar cambio) o 17 GetCashBoxLevel (cajón de recaudación). */
  function niveles(codigo) {
    if (codigo === "79") {
      return `$79|1|${DENOMINACIONES.join(",")}|${DENOMINACIONES.map((v) => m.cambio[v]).join(",")}|${DENOMINACIONES.map(() => "EUR").join(",")}#`;
    }
    return `$17|1|EUR|${DENOMINACIONES.join(",")}|${DENOMINACIONES.map((v) => m.recaudacion[v]).join(",")}#`;
  }

  function atenderConsulta(socket, codigo, p) {
    const responder = (texto) => mandar(socket, texto);
    if (codigo === "38") return responder("$38|1|EUR|#");
    if (codigo === "78") return responder(`$78|1|${DENOMINACIONES.filter((v) => v < 500).join(",")}|${DENOMINACIONES.filter((v) => v >= 500).join(",")}#`);
    if (codigo === "19") return responder(`$19|1|${p[0].split(",").map(v=>m.cambio[Number(v)] ?? 0).join(",")}#`);
    if (codigo === "79" || codigo === "17") return responder(niveles(codigo));
    return responder(`$${codigo}|0|42|Orden no esperada#`);
  }

  function servidor(puerto, esControl) {
    return net
      .createServer((socket) => {
        // La conexión de control tiene un solo dueño (si no, sería CKMonitor y el programa a la vez).
        if (esControl && m.cliente && !m.cliente.destroyed) {
          traza("conexion", "rechazada", "control");
          return socket.destroy();
        }
        traza("conexion", "abierta", esControl ? "control" : "consulta");
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
            traza("entra", `$${mensaje}#`, esControl ? "control" : "consulta");
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
            else atenderConsulta(socket, codigo, p);
          }
        });
        socket.on("close", () => {
          traza("conexion", "cerrada", esControl ? "control" : "consulta");
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
    totalCambio: () => total(m.cambio),
    totalRecaudacion: () => total(m.recaudacion),
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
  const lista = (unidades) =>
    DENOMINACIONES.filter((v) => unidades[v] > 0)
      .map((v) => `${unidades[v]} × ${euros(v)}`)
      .join(", ") || "nada";
  console.log("Teclas: 1 y 2 = monedas de 1 y 2 €; 5, 0, v y c = billetes de 5, 10, 20 y 50 €; n = lo que tiene; q = salir.");
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("keypress", (tecla) => {
    if (tecla === "q" || tecla === "\u0003") {
      ck.cerrar();
      process.exit(0);
    }
    if (tecla === "f") {
      ck.maquina.fallarVaciado = true;
      console.log("El próximo vaciado de recicladores o cierre por niveles fallará (error 42), sin mover nada.");
      return;
    }
    if (tecla === "n") {
      console.log(`Para dar cambio (${euros(ck.totalCambio())}): ${lista(ck.maquina.cambio)}`);
      console.log(`Cajón de recaudación (${euros(ck.totalRecaudacion())}): ${lista(ck.maquina.recaudacion)}`);
      return;
    }
    const valor = teclas[tecla];
    if (!valor) return;
    if (ck.meter(valor)) console.log(`Metido ${euros(valor)} → llevo ${euros(ck.maquina.introducido)} de ${euros(ck.maquina.objetivo)}`);
    else console.log("La máquina no está esperando dinero ahora (pide un cobro desde la caja).");
  });
  setInterval(() => {}, 1 << 30);
}
