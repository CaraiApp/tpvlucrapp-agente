import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { actualizarWindows, sustituirPreparado } from '../instalacion-windows.mjs';
import { marcarCajon, hayCajonEnMarcha, seEstaActualizando, empezarActualizacion, esperarCajonLibre } from '../en-marcha.mjs';

function escenario(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpv-instalar-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const origen=path.join(dir,'descargado.exe'), destino=path.join(dir,'programa','tpvlucrapp-agente.exe');
  fs.mkdirSync(path.dirname(destino)); fs.writeFileSync(origen,'nuevo'); fs.writeFileSync(destino,'anterior');
  const llamadas=[];
  const opciones={origen,destino,nombreTarea:'TPV Lucrapp Agente',
    ejecutar:async(cmd,args)=>{llamadas.push([cmd,...args.slice(0,4)]);return cmd==='powershell'?JSON.stringify({existe:true,habilitada:true,activa:true}):'';},
    parar:async()=>{llamadas.push(['parar']);},registrar:async()=>{llamadas.push(['registrar']);}};
  return {dir,origen,destino,llamadas,opciones};
}
test('actualización sustituye después de parar, reinicia y conserva los datos',async t=>{
 const e=escenario(t);const datos=path.join(e.dir,'datos.json');fs.writeFileSync(datos,'enlace y diario');
 await actualizarWindows(e.opciones);
 assert.equal(fs.readFileSync(e.destino,'utf8'),'nuevo');assert.equal(fs.readFileSync(datos,'utf8'),'enlace y diario');
 assert.ok(e.llamadas.findIndex(x=>x[0]==='parar')<e.llamadas.findIndex(x=>x[0]==='registrar'));
 assert.equal(e.llamadas.at(-1)[1],'/Run');assert.deepEqual(fs.readdirSync(path.dirname(e.destino)),['tpvlucrapp-agente.exe']);
});
test('bloqueo transitorio conserva anterior hasta que puede sustituirlo',async t=>{
 const e=escenario(t);let intentos=0;
 await sustituirPreparado(e.origen,e.destino,{dormir:async()=>{},renombrar:(a,b)=>{
   if(++intentos<3){assert.equal(fs.readFileSync(b,'utf8'),'anterior');throw Object.assign(new Error('ocupado'),{code:'EBUSY'});}fs.renameSync(a,b);
 }});
 assert.equal(intentos,3);assert.equal(fs.readFileSync(e.destino,'utf8'),'nuevo');
});
test('bloqueo permanente conserva binario anterior y restaura arranque',async t=>{
 const e=escenario(t);
 e.opciones.sustituir=(a,b)=>sustituirPreparado(a,b,{intentos:2,dormir:async()=>{},renombrar:()=>{throw Object.assign(new Error('ocupado'),{code:'EBUSY'});}});
 await assert.rejects(actualizarWindows(e.opciones),/Windows sigue bloqueando/);
 assert.equal(fs.readFileSync(e.destino,'utf8'),'anterior');assert.equal(e.llamadas.at(-1)[1],'/Run');
 assert.ok(!e.llamadas.some(x=>x[0]==='registrar'));assert.deepEqual(fs.readdirSync(path.dirname(e.destino)),['tpvlucrapp-agente.exe']);
});
test('fallo al parar impide sustituir y restaura tarea',async t=>{
 const e=escenario(t);e.opciones.parar=async()=>{throw new Error('No termina');};
 await assert.rejects(actualizarWindows(e.opciones),/No termina/);assert.equal(fs.readFileSync(e.destino,'utf8'),'anterior');assert.equal(e.llamadas.at(-1)[1],'/Run');
});
test('no para ni copia si no puede deshabilitar el rearranque',async t=>{
 const e=escenario(t),original=e.opciones.ejecutar;e.opciones.ejecutar=async(c,a)=>{if(a.includes('/Disable'))throw new Error('Sin permiso');return original(c,a);};
 await assert.rejects(actualizarWindows(e.opciones),/Sin permiso/);assert.ok(!e.llamadas.some(x=>x[0]==='parar'));assert.equal(fs.readFileSync(e.destino,'utf8'),'anterior');
});
test('no interrumpe servicio si falta el instalador origen',async t=>{
 const e=escenario(t);fs.unlinkSync(e.origen);await assert.rejects(actualizarWindows(e.opciones));assert.equal(e.llamadas.length,0);assert.equal(fs.readFileSync(e.destino,'utf8'),'anterior');
});
test('segunda instalación no entra ni borra el candado de la primera',async t=>{
 const e=escenario(t);const candado=path.join(path.dirname(e.destino),'actualizacion.lock');fs.writeFileSync(candado,String(process.pid));
 await assert.rejects(actualizarWindows(e.opciones),/otra instalación/);assert.equal(e.llamadas.length,0);assert.ok(fs.existsSync(candado));
});
test('un error de disco no se reintenta como bloqueo',async()=>{
 let intentos=0;await assert.rejects(sustituirPreparado('a','b',{renombrar:()=>{intentos++;throw Object.assign(new Error('Sin espacio'),{code:'ENOSPC'});}}),/Sin espacio/);assert.equal(intentos,1);
});

// Cerrar el programa con una operación del cajón a medias deja la máquina a medio cobro: el instalador espera a que acabe.
function carpeta(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpv-en-marcha-')); t.after(() => fs.rmSync(dir, { recursive:true, force:true })); return dir; }
function marcaDeOtro(dir, nombre, { pid = process.ppid, hace = 0 } = {}) { fs.writeFileSync(path.join(dir, nombre), JSON.stringify({ pid, en: new Date(Date.now() - hace).toISOString() })); }
test('el instalador espera a que acabe la operación del cajón y lo avisa una sola vez', async t => {
  const dir = carpeta(t); marcaDeOtro(dir, 'cajon-en-marcha.json');
  assert.equal(hayCajonEnMarcha(dir), true);
  let avisos = 0; let vueltas = 0;
  await esperarCajonLibre(dir, { avisar: () => avisos++, intervalo: 1, esperar: async () => { if (++vueltas === 3) fs.rmSync(path.join(dir, 'cajon-en-marcha.json')); } });
  assert.equal(avisos, 1); assert.equal(vueltas, 3);
});
test('una marca vieja, de un programa que ya no está o del propio proceso no hace esperar', async t => {
  const dir = carpeta(t); const muerto = spawnSync(process.execPath, ['-e', '0']).pid;
  marcaDeOtro(dir, 'cajon-en-marcha.json', { hace: 2 * 60_000 }); assert.equal(hayCajonEnMarcha(dir), false);
  marcaDeOtro(dir, 'cajon-en-marcha.json', { pid: muerto }); assert.equal(hayCajonEnMarcha(dir), false);
  marcarCajon(dir, true); assert.equal(hayCajonEnMarcha(dir), false);
  let avisos = 0; await esperarCajonLibre(dir, { avisar: () => avisos++ }); assert.equal(avisos, 0);
});
test('si la operación del cajón no acaba, el instalador no cierra nada y lo dice', async t => {
  const dir = carpeta(t); marcaDeOtro(dir, 'cajon-en-marcha.json');
  await assert.rejects(esperarCajonLibre(dir, { limite: 0, esperar: async () => {} }), /No se ha cambiado nada/);
});
test('el programa sabe que se está actualizando; cada uno solo quita su marca', async t => {
  const dir = carpeta(t);
  assert.equal(seEstaActualizando(dir), false);
  marcaDeOtro(dir, 'actualizando.json'); assert.equal(seEstaActualizando(dir), true);
  marcaDeOtro(dir, 'actualizando.json', { hace: 31 * 60_000 }); assert.equal(seEstaActualizando(dir), false);
  const quitar = empezarActualizacion(dir); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'actualizando.json'), 'utf8')).pid, process.pid);
  quitar(); assert.equal(fs.existsSync(path.join(dir, 'actualizando.json')), false);
  marcaDeOtro(dir, 'cajon-en-marcha.json'); marcarCajon(dir, false); assert.equal(fs.existsSync(path.join(dir, 'cajon-en-marcha.json')), true);
  marcarCajon(dir, true); marcarCajon(dir, false); assert.equal(fs.existsSync(path.join(dir, 'cajon-en-marcha.json')), false);
});
