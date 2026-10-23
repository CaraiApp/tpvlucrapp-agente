# Ejecutar solo en el runner Windows de CI, nunca contra un TPV real.
param([string]$Programa = '.\tpvlucrapp-agente-windows.exe')
$ErrorActionPreference = 'Stop'
$instaladoTpv = 'C:\Program Files\TPV Lucrapp\tpvlucrapp-agente.exe'
$datosTpv = 'C:\ProgramData\TPV Lucrapp'
$descargaTpv = 'C:\salida\tpvlucrapp-agente-windows (12).exe'
$otraRutaTpv = 'C:\salida\otra-copia\tpvlucrapp-agente.exe'
function ProcesosInstalados {
  @(Get-Process -Name tpvlucrapp-agente -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $instaladoTpv })
}
function EsperarInstalado {
  for ($intentoTpv=0; $intentoTpv -lt 30; $intentoTpv++) {
    $procesosTpv = @(ProcesosInstalados)
    if ($procesosTpv.Count -eq 1) { return $procesosTpv[0] }
    Start-Sleep -Milliseconds 500
  }
  throw 'No hay exactamente un servicio instalado en marcha.'
}
New-Item -ItemType Directory -Force "$datosTpv\cashkeeper-operaciones","$datosTpv\cashkeeper-conexiones",(Split-Path $otraRutaTpv) | Out-Null
# Datos sintéticos. Cualquier intento de conexión queda en loopback.
Set-Content "$datosTpv\agente.json" '{"token":"solo-prueba-local","api":"http://127.0.0.1:9","agente":"Prueba"}'
Set-Content "$datosTpv\cashkeeper-operaciones\pendiente.json" '{"id":"prueba","final":{"resultado":{"conciliar":true}},"saldo":{"introducido":50,"devuelto":0}}'
Set-Content "$datosTpv\cashkeeper-conexiones\pausa.json" '{"pausada":true}'
$archivosTpv = @("$datosTpv\agente.json","$datosTpv\cashkeeper-operaciones\pendiente.json","$datosTpv\cashkeeper-conexiones\pausa.json")
$huellasTpv = @($archivosTpv | Get-FileHash | Select-Object -ExpandProperty Hash)
Copy-Item $Programa $descargaTpv -Force
Copy-Item $Programa $otraRutaTpv -Force
$otraTpv = Start-Process $otraRutaTpv -ArgumentList '--servicio' -PassThru -WindowStyle Hidden
try {
  $anteriorTpv = EsperarInstalado
  & $descargaTpv --instalar
  if ($LASTEXITCODE -ne 0) { throw 'Falló la actualización sobre el servicio activo.' }
  $nuevoTpv = EsperarInstalado
  if ($nuevoTpv.Id -eq $anteriorTpv.Id) { throw 'No se reemplazó el proceso anterior.' }
  $otraTpv.Refresh()
  if ($otraTpv.HasExited) { throw 'Se cerró una copia ajena a la ruta instalada.' }
  if ((Get-FileHash $instaladoTpv).Hash -ne (Get-FileHash $Programa).Hash) { throw 'El binario instalado no coincide.' }
  if (-not (Get-ScheduledTask -TaskName 'TPV Lucrapp Agente').Settings.Enabled) { throw 'El arranque quedó deshabilitado.' }

  # Reproduce un ejecutable bloqueado por una instancia ajena al Programador de tareas.
  Stop-ScheduledTask -TaskName 'TPV Lucrapp Agente'
  $nuevoTpv.WaitForExit(15000) | Out-Null
  Unregister-ScheduledTask -TaskName 'TPV Lucrapp Agente' -Confirm:$false
  $manualTpv = Start-Process $instaladoTpv -ArgumentList '--servicio' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1
  & $descargaTpv --instalar
  if ($LASTEXITCODE -ne 0) { throw 'Falló la actualización con proceso sin tarea.' }
  $manualTpv.Refresh()
  if (-not $manualTpv.HasExited) { throw 'Sigue abierto el proceso que bloqueaba el archivo.' }
  EsperarInstalado | Out-Null
  $despuesTpv = @($archivosTpv | Get-FileHash | Select-Object -ExpandProperty Hash)
  if (Compare-Object $huellasTpv $despuesTpv) { throw 'Cambió el enlace, la pausa o el diario CashKeeper.' }
  if (Test-Path 'C:\Program Files\TPV Lucrapp\actualizacion.lock') { throw 'Quedó un candado de instalación.' }
  'Correcto: actualización con servicio activo y proceso sin tarea; conserva enlace, pausa, diario y copia ajena.'
} finally {
  if (-not $otraTpv.HasExited) { Stop-Process -InputObject $otraTpv -Force }
}
