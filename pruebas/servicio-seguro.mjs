// Prueba del ejecutable completo: API, CashKeeper/CKMonitor e impresora sintéticos en loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
export async function probarServicio(programa, modo) {
  assert.ok(programa && fs.existsSync(programa),'Indica el programa compilado o tpvlucrapp-agente.mjs');
  programa=path.resolve(programa);
  const datos=fs.mkdtempSync(path.join(os.tmpdir(),'ck-servicio-'));
  const sockets=new Set();const ordenes=[];const finales=new Map();let impresion=false;let recibido=false;let cursor=0;let reponer=false;let entregada=false;let hijo;
  const escuchar=async servidor=>{servidor.listen(0,'127.0.0.1');await once(servidor,'listening');return servidor.address().port;};
  const registrar=s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});};
  let pagos=0;
  const ck=net.createServer(s=>{registrar(s);let buffer='';s.on('data',trozo=>{
    if(modo==='ckmonitor') {const cmd=trozo.toString();ordenes.push(cmd);const [c,t]=cmd.split('|');s.end(c==='C'?'OK|Added':t==='ticket-a'?'OK|OK':'NOK|Not found');return;}
    buffer+=trozo;
    while(buffer.includes('#')) {const i=buffer.indexOf('#');const cmd=buffer.slice(1,i);buffer=buffer.slice(i+1);ordenes.push(cmd);const [c]=cmd.split('|');
      if(c==='47')s.write('$57|123#');else if(c==='57')s.write('$58|TEST#');else if(c==='39')s.write('$39|1#$106|1|0#');else if(c==='40')s.write('$40|1|1#');else if(c==='43')s.write('$43|1|0#');else if(c==='38')s.write('$38|1|EUR|#');
      else if(c==='42')s.write('$42|1#$107|500|320|0#$108|180|180|0#$100|0||180|180|3|0#');
      else if(c==='44')s.write('$44|1|180#');else if(c==='52')s.write('$52|1#');
      else if(c==='29'){pagos++;s.write(pagos===1?'$29|1#$108|500|500|0#$100|0||500|500|3|0#':'$29|1#$108|400|500|0#$100|32|Atasco|400|500|3|0#');}
      else throw new Error('Comando inesperado '+c);
    }
  });});
  const puerto=await escuchar(ck);
  const impresora=net.createServer(s=>{registrar(s);s.on('data',()=>{recibido=true;});s.on('end',()=>s.end());});
  const puertoImpresora=await escuchar(impresora);
  const ops=['a','b','c'].map(x=>({id:`op-${x}`,ticket:`ticket-${x}`,tipo:'salida',modo,host:'127.0.0.1',puerto,semilla:'100001',importe_centimos:500,propina_centimos:0,reanudar:false,orden:modo==='ckmonitor'?`C|ticket-${x}|-500`:null}));
  if(modo==='directo')ops.unshift({...ops[0],id:'op-d',tipo:'cobro',importe_centimos:320});
  const primera=ops[0].id;
  let trabajo=false;
  const api=http.createServer((req,res)=>{let texto='';req.on('data',x=>texto+=x);req.on('end',()=>{
    const enviar=x=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(x));};
    if(req.url==='/v1/agente/latido')return enviar({agente:{nombre:'Simulador'},impresoras:[],cajones_directos:[]});
    if(req.url.startsWith('/v1/agente/trabajos?')){
      let cajon=[];
      if(reponer&&!entregada){cajon=[{...ops[0],reanudar:true}];entregada=true;}
      else if(!reponer&&cursor<ops.length&&(cursor===0||finales.has(ops[cursor-1].id))){cajon=[ops[cursor++]];}
      const trabajos=trabajo?[]:[{id:'impresion-1',tipo:'prueba',titulo:'Simulador',copias:1,impresora:{id:'impresora-1',nombre:'Simulada',tipo:'red',direccion:'127.0.0.1',puerto:puertoImpresora},datos:Buffer.from('PRUEBA SIN HARDWARE\n').toString('base64')}];trabajo=true;
      return setTimeout(()=>enviar({cajon,trabajos}),100);
    }
    const m=/\/cajon\/(op-[abcd])\/estado$/.exec(req.url);
    if(m){const b=JSON.parse(texto);if(b.estado!=='en_curso')finales.set(m[1],b);return enviar({estado:b.estado});}
    if(req.url==='/v1/agente/trabajos/impresion-1/resultado'){impresion=JSON.parse(texto).estado==='impreso';return enviar({ok:true});}
    res.writeHead(404);res.end('{}');
  });});
  const apiPuerto=await escuchar(api);
  const arrancar=()=>{const esScript=programa.endsWith('.mjs');hijo=spawn(esScript?process.execPath:programa,esScript?[programa,'--servicio']:['--servicio'],{env:{...process.env,TPV_API:`http://127.0.0.1:${apiPuerto}`,TPV_AGENTE_TOKEN:'token-sintetico',TPV_AGENTE_DATOS:datos},stdio:'ignore'});};
  const parar=async()=>{if(hijo&&hijo.exitCode===null){const fin=once(hijo,'exit');hijo.kill();await fin;}};
  const esperar=async fn=>{const limite=Date.now()+20000;while(!fn()&&Date.now()<limite)await new Promise(r=>setTimeout(r,50));assert.ok(fn(),'El servicio no terminó la prueba en 20 s');};
  try {
    arrancar();await esperar(()=>finales.size===ops.length&&impresion);
    assert.equal(finales.get('op-a').estado,'cobrada');assert.equal(finales.get('op-b').resultado.conciliar,true);assert.equal(finales.get('op-c').resultado.conciliar,true);assert.ok(recibido);
    if(modo==='directo'){assert.equal(finales.get('op-d').estado,'cobrada');assert.equal(finales.get('op-d').progreso.introducido,500);assert.equal(finales.get('op-d').progreso.devuelto,180);}
    const movidas=()=>ordenes.filter(x=>modo==='directo'?x.startsWith('29|'):x.startsWith('C|')).length;
    assert.equal(movidas(),2);await parar();finales.delete(primera);reponer=true;arrancar();await esperar(()=>finales.has(primera));assert.equal(finales.get(primera).estado,'cobrada');assert.equal(movidas(),2);if(modo==='directo')assert.equal(ordenes.filter(x=>x.startsWith('42|')).length,1);
    console.log(`PASS servicio ${modo}: éxito, parcial/incierto, bloqueo, impresión y replay tras reinicio sin mover dinero otra vez`);
  } catch(e) {console.error('Estados simulados:',Object.fromEntries(finales));throw e;}
  finally {await parar();api.closeAllConnections();for(const s of sockets)s.destroy();await Promise.all([api,ck,impresora].map(s=>new Promise(r=>s.close(r))));fs.rmSync(datos,{recursive:true,force:true});}
}
