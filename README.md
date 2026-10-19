# Agente de impresión de TPV Lucrapp

Un programa pequeño que corre en un ordenador del local y manda a las impresoras de tickets en red (ESC/POS, puerto 9100)
lo que la caja de **TPV Lucrapp** deja en la cola: comandas, tickets, informes de cierre, apertura del cajón y pruebas.

## Instalación (sin instalar nada más)

1. Descarga el programa de la última versión en **Releases** (a la derecha):
   `tpvlucrapp-agente-windows.exe` (Windows), `tpvlucrapp-agente-mac-apple-silicon.zip` (Mac con chip Apple) o
   `tpvlucrapp-agente-mac-intel.zip` (Mac con Intel). En Mac, descomprime el zip.
2. En la oficina de TPV Lucrapp → **Impresión y pantallas** → **Agente de impresión** → «Nuevo agente», copia el código de enlace.
3. Abre el programa y pega el código. Lo guarda en un archivo `agente.json` a su lado y a partir de ahí arranca solo.
   Déjalo abierto (o ponlo en los programas de inicio): la oficina lo verá «en línea».

- Windows avisa «Windows protegió tu PC» la primera vez: **Más información → Ejecutar de todas formas** (el programa aún no va firmado).
- Mac avisa de que no puede comprobarlo: Ajustes del Sistema → **Privacidad y seguridad** → «Abrir de todos modos».

Probar una impresora sin pasar por la caja: `tpvlucrapp-agente --probar 192.168.1.50:9100`.

## Para desarrolladores

El programa es `tpvlucrapp-agente.mjs` (Node.js 18 o más moderno también lo ejecuta: `node tpvlucrapp-agente.mjs`).
Los ejecutables se generan con [Bun](https://bun.sh): `bun build ./tpvlucrapp-agente.mjs --compile --target=bun-windows-x64 --outfile tpvlucrapp-agente-windows.exe`
(y `bun-darwin-arm64`, `bun-darwin-x64`).
