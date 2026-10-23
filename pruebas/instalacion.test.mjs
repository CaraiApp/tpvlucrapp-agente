import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actualizarWindows, sustituirPreparado } from '../instalacion-windows.mjs';

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
