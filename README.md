# Programa del ordenador de TPV Lucrapp

El programa que se instala **una vez** en un ordenador del local y se queda funcionando en segundo plano: arranca solo
cada vez que se enciende el ordenador, sin ventanas. Manda a las impresoras lo que la caja de **TPV Lucrapp** deja en la
cola (comandas, tickets, informes de cierre, apertura del cajón y pruebas):

- a las **impresoras instaladas en el ordenador** (USB o de red, las que ve Windows o Mac), por su propia cola de impresión;
- o a **impresoras de red por IP** (ESC/POS, puerto 9100).

Y le cuenta a la oficina qué impresoras tiene el ordenador, para darlas de alta con un toque.

## Instalación

1. En la oficina de TPV Lucrapp → **Impresión y pantallas** → **Conectar un ordenador**: ponle un nombre y te dará un
   código (por ejemplo `K7PQ-4XMW`, vale una vez y caduca en una hora).
2. En ese ordenador, descarga el programa de la última versión en **Releases**: `tpvlucrapp-agente-windows.exe`
   (Windows), `tpvlucrapp-agente-mac-apple-silicon.zip` (Mac con chip Apple) o `tpvlucrapp-agente-mac-intel.zip` (Mac con
   Intel; descomprime el zip).
3. Ábrelo y escribe el código. En Windows pide permiso de administrador una vez («Sí»): lo necesita para arrancar solo con
   el ordenador. Listo: no hay que volver a abrir nada.
4. En la oficina → **Añadir impresora** salen las impresoras de ese ordenador: elige cuáles usar.

- Windows avisa «Windows protegió tu PC» la primera vez: **Más información → Ejecutar de todas formas** (el programa aún no va firmado).
- Mac avisa de que no puede comprobarlo: clic derecho → **Abrir**, o Ajustes del Sistema → **Privacidad y seguridad** → «Abrir de todos modos».

**Actualizar en Windows (0.8.3):** termina cualquier cobro o devolución en curso y abre la nueva descarga. Cuando indique que el ordenador ya está conectado, pulsa Enter sin escribir otro código. El instalador prepara la nueva copia, pausa el arranque automático, cierra únicamente el ejecutable instalado y espera a que termine antes de sustituirlo. Reintenta brevemente si Windows sigue bloqueando el archivo. Conserva el enlace, la pausa de CashKeeper y su diario; no hace falta desinstalar. Si no puede sustituirlo, conserva el binario anterior y restaura la tarea previa. El error `EBUSY` de versiones anteriores indicaba que el ejecutable seguía ocupado.

## Cajón automático (CashKeeper)

Desde la 0.4.0, si el local tiene un **CashKeeper**, el programa del ordenador donde está **CKMonitor** le pasa los
cobros en efectivo de la caja: la máquina recoge el dinero y da la vuelta, y la caja lo apunta cuando la máquina lo
confirma.

1. En CKMonitor, activa la conexión **CKFast** (puerto 16501 de serie).
2. En la oficina → **Impresión y pantallas** → **Cajones automáticos** → **Añadir CashKeeper**: elige este ordenador y
   deja `127.0.0.1` y el puerto 16501 si CKMonitor está en él. Pulsa **Probar**: debe decir «CKMonitor contesta».
3. En **Cajón de cada caja**, elige el cajón para la caja que cobra con él.

Para comprobarlo desde el propio ordenador: `tpvlucrapp-agente --probar-cashkeeper 127.0.0.1:16501`.

**Leer el efectivo** (desde la 0.5.0): para ver al abrir y al cerrar la caja cuántas monedas y billetes de cada valor hay,
el programa entra en la propia máquina por su conexión de solo consulta (puerto 8002, con su clave; de fábrica 100001).
No mueve dinero ni toca lo que hace CKMonitor. En el cajón (oficina → Editar) pon la **IP de la máquina** (la que sale en
su pantalla) y, si el instalador la cambió, la clave. Para comprobarlo: `tpvlucrapp-agente --leer-cashkeeper
192.168.1.20 [CLAVE]`.

## CashKeeper directo y recuperación (0.8.2)

La conexión directa utiliza Raw Sockets del manual de integración V3. Se controla desde **Caja → CashKeeper**:

- Conectar y desconectar manualmente. La pausa se conserva al reiniciar Windows y no para la impresión.
- Consultar estado, crédito, niveles, identificación, firmware y contadores. La consulta no mueve dinero.
- Configurar denominaciones, máximos, mínimos, protecciones, limpieza, idioma y pantalla, según el modelo.
- Aceptar o rechazar avisos de protección de cambio con autorización y plazo. Si nadie responde, se rechaza.
- Recuperar una entrada o un pago interrumpido con evidencia de la máquina y del registro local. Un pago parcial se continúa solo por la diferencia. Una salida puede cerrarse con lo que realmente se entregó.
- Elegir denominaciones en una salida respetando el límite antiatraco. Una función no soportada no se sustituye por otra que ignore el límite.

Desde la 0.8.1, la lectura funciona también cuando la máquina rechaza `GetLastLevels` (orden 79). Se descubren las denominaciones con la orden 78 o, en EUR, se consultan sus valores individualmente con la 19 si es necesario. Las cantidades siempre se leen de la máquina; un fallo de conexión no se interpreta como inventario vacío. Office y la conexión directa comparten esta lectura.

La 0.8.2 incluye el rechazo explícito 40 en esas alternativas de lectura. «Dar cambio» comprueba el inventario antes de admitir dinero, para detectar incompatibilidades antes de comenzar.

Si un cambio anterior aceptó dinero y falló antes de ordenar su devolución, el TPV conserva el importe recibido aunque el crédito de la máquina marque cero. Tras consultar su estado, el responsable puede solicitar «Devolver el cambio pendiente», confirmando que nadie lo devolvió por otra vía. El agente exige que su diario acredite la entrada aceptada, saldo sin devolver y ninguna orden de pago posterior; comprueba reposo y crédito cero antes de pagar una sola vez. Solo cierra la incidencia cuando se confirma la devolución completa. Un corte o pago parcial conserva el bloqueo; no se repite la orden.

En **Ver monedas y billetes**, el TPV separa lo disponible para pagar de la recaudación. La salida manual muestra solo piezas disponibles, con botones + y − limitados a sus existencias. El agente comprueba las cantidades otra vez antes de ordenar el pago.

Cancelar «Dar cambio» sin introducir dinero no crea un asiento de0€. Un corte o un resultado desconocido conserva la incidencia; no se repite la orden al reiniciar. Desconectar no borra crédito pendiente y no se permite durante una operación física activa.

**Actualizar:** descarga y ejecuta la nueva versión en el ordenador enlazado. Actualizar la web no actualiza por sí solo el programa Windows. No borres su carpeta de datos: contiene el enlace y el diario que evita repetir operaciones.

La recuperación necesita un diagnóstico reciente y coherente. Un atasco requiere actuación física; un corte durante la recuperación o dinero sin evidencia suficiente mantiene el bloqueo para revisión. No se actualiza firmware, cambia la red de la máquina ni fuerza inventario desde Caja. La operativa comercial es EUR; redondeos automáticos y aceptación multidivisa no están habilitados.

La aplicación funciona en segundo plano, sin ventana propia. Los controles están en el TPV. El ejecutable Windows sigue sin firma de editor; esta versión no elimina SmartScreen.

## Dónde queda

| | Windows | Mac |
| --- | --- | --- |
| Programa | `C:\Program Files\TPV Lucrapp\` (con `rawprint.exe`, el ayudante que imprime tal cual) | `~/Library/Application Support/TPV Lucrapp/` |
| Arranque | Tarea «TPV Lucrapp Agente»: al encender, como SYSTEM, se reinicia si se cae | `~/Library/LaunchAgents/com.tpvlucrapp.agente.plist` |
| Enlace y registro | `C:\ProgramData\TPV Lucrapp\agente.json` y `agente.log` | `agente.json` y `agente.log` en la carpeta del programa |

## Órdenes

```
tpvlucrapp-agente                                    instalar o ver el estado (con doble clic)
tpvlucrapp-agente --impresoras                       las impresoras que ve este ordenador
tpvlucrapp-agente --probar 192.168.1.50:9100         prueba en una impresora de red
tpvlucrapp-agente --probar-impresora "EPSON TM-T20"  prueba en una impresora del ordenador
tpvlucrapp-agente --probar-cashkeeper 127.0.0.1:16501   comprueba que CKMonitor contesta (cajón automático CashKeeper)
tpvlucrapp-agente --leer-cashkeeper 192.168.1.20 [CLAVE] lee el efectivo de la máquina (conexión de consulta)
tpvlucrapp-agente --enlazar K7PQ-4XMW                enlazar sin preguntar (instalación desatendida)
tpvlucrapp-agente --instalar                         dejarlo en segundo plano sin preguntar
tpvlucrapp-agente --desinstalar                      quitarlo de este ordenador
```

## Para desarrolladores

El programa es `tpvlucrapp-agente.mjs` (Node.js 18+ también lo ejecuta, pero entonces no arranca solo). Los ejecutables
los hace GitHub Actions (`.github/workflows/programa.yml`) con [Bun](https://bun.sh); en Windows se prueba de verdad
con una impresora que escribe a un archivo. Al etiquetar `vX.Y.Z` se publican en Releases.
Para probar contra otro backend: `TPV_API=http://localhost:3001` (y `TPV_AGENTE_DATOS=/carpeta` para no tocar la del sistema).
