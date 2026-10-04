import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {MediaQuiescence} from '../src/quiescence.js';
import {createPythonWorker} from '../src/worker.js';

const context=id=>({commandId:'command-'+id,fenceId:id,purpose:'distribution-update',instanceId:'owned-instance',dataScope:'owned-scope'});
const proof=c=>({kind:'distribution-admission-abort',verified:true,purpose:'distribution-update',receiptId:'supervisor-'+c.fenceId,...Object.fromEntries(['commandId','fenceId','instanceId','dataScope'].map(key=>[key,c[key]]))});
const abort=(g,c,p=proof(c))=>g.participant().abortAdmission({...c,proof:p});
async function fixture(t,{worker=()=>undefined}={}){
 const directory=await mkdtemp(join(tmpdir(),'media-abort-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const counts={effects:0},gaps=[];let gate;
 const open=()=>gate=new MediaQuiescence(directory,()=>({counts,gaps}),worker);
 open();t.after(()=>gate?.close());
 return {directory,counts,gaps,get gate(){return gate},close(){gate?.close();gate=undefined},restart(){gate?.close();open()}};
}

test('held abort returns the exact durable receipt after lost reply and restart; retries do not clear a new fence',async t=>{
 const f=await fixture(t),c=context('held');assert.ok(await f.gate.participant().acquire(c));
 const result=await abort(f.gate,c);assert.equal(result.status,'released');assert.equal(f.gate.inspect().intakeClosed,false);
 f.restart();assert.deepEqual(await abort(f.gate,c),result);
 const next=context('next');assert.ok(await f.gate.participant().acquire(next));
 assert.deepEqual(await abort(f.gate,c),result);assert.equal(f.gate.current().fenceId,next.fenceId);
 await assert.rejects(abort(f.gate,c,{...proof(c),receiptId:'changed'}),/retained proof/);
 assert.equal(f.gate.current().fenceId,next.fenceId);await abort(f.gate,next);
 await assert.rejects(f.gate.participant().acquire(c),/cannot be acquired again/);
});

test('busy refusal is durable before returning null; pending work blocks abort until it settles',async t=>{
 const f=await fixture(t),c=context('busy');f.counts.effects=1;
 assert.equal(await f.gate.participant().acquire(c),null);
 assert.equal(JSON.parse(f.gate.db.prepare('SELECT value FROM receipts WHERE id=?').get(c.fenceId).value).state,'refused');
 await assert.rejects(abort(f.gate,c),/pending or unknown/);
 f.counts.effects=0;f.restart();const result=await abort(f.gate,c);assert.equal(result.status,'not-acquired');
 assert.deepEqual(await abort(f.gate,c),result);assert.equal(f.gate.inspect().intakeClosed,false);
 await assert.rejects(f.gate.participant().acquire(c),/cannot be acquired again/);
});

test('missing attempts, legacy unknown fences and missing held rows never prove non-acquisition',async t=>{
 const f=await fixture(t),c=context('absent');await assert.rejects(abort(f.gate,c),/durable media admission attempt/);
 f.gate.save({...c,ownerId:'media',state:'held'});f.restart();assert.equal(f.gate.current().state,'unknown');
 await assert.rejects(abort(f.gate,c),/durable media admission attempt/);assert.equal(f.gate.current().state,'unknown');
 const other=await fixture(t),held=context('missing-row');await other.gate.participant().acquire(held);
 other.gate.db.prepare('DELETE FROM fence WHERE id=1').run();await assert.rejects(abort(other.gate,held),/settlement is unavailable/);
});

test('every stale binding, generic release proof and additional proof field refuses without clearing intake',async t=>{
 const f=await fixture(t),c=context('identity');await f.gate.participant().acquire(c);
 for(const key of ['commandId','fenceId','instanceId','dataScope']){
  const changed={...c,[key]:'different'};await assert.rejects(abort(f.gate,changed),/attempt/);
  await assert.rejects(abort(f.gate,c,{...proof(c),[key]:'different'}),/abort proof/);
 }
 for(const p of [{kind:'admission-refused'},{...proof(c),kind:'distribution-release'},{...proof(c),extra:true},{...proof(c),verified:1}])await assert.rejects(abort(f.gate,c,p),/abort proof/);
 assert.equal(f.gate.inspect().intakeClosed,true);await abort(f.gate,c);
});

test('unknown provider lifetime cannot be waived by a supervisor admission abort',async t=>{
 const f=await fixture(t),c=context('unknown-call');f.gate.call('unknown','unverified');
 assert.equal(await f.gate.participant().acquire(c),null);f.restart();
 await assert.rejects(abort(f.gate,c),/pending or unknown/);assert.equal(f.gate.inspect().unverifiedCalls,1);
});

test('a lost worker acquire reply followed by worker absence after restart remains unknown',async t=>{
 let available=true,attempts=0;const worker={async request(method){if(method==='quiescence.acquire'){attempts++;throw Error('lost reply')}throw Error('worker no longer available')}};
 const f=await fixture(t,{worker:()=>available?worker:undefined}),c=context('lost-worker');
 await assert.rejects(f.gate.participant().acquire(c),/lost reply/);assert.equal(attempts,1);
 available=false;f.restart();await assert.rejects(abort(f.gate,c),/evidence unavailable after restart/);
 assert.equal(f.gate.inspect().intakeClosed,true);assert.equal(f.gate.current().state,'unknown');assert.equal(attempts,1);
});

test('worker abort response must bind every original identity and a conclusive status',async t=>{
 let bad;const worker={async request(method,args){if(method==='quiescence.acquire')return {held:true,ownerId:args.ownerId,fenceId:args.context.fenceId};return bad}};
 const f=await fixture(t,{worker:()=>worker}),c=context('bad-worker');await f.gate.participant().acquire(c);
 const good={ownerId:'media',status:'released',receiptId:'worker-receipt',...Object.fromEntries(['commandId','fenceId','instanceId','dataScope'].map(key=>[key,c[key]]))};
 for(const key of ['ownerId','commandId','fenceId','instanceId','dataScope','status']){
  bad={...good,[key]:'foreign'};await assert.rejects(abort(f.gate,c),/worker admission abort receipt/);assert.equal(f.gate.inspect().intakeClosed,true);
 }
 bad=good;assert.equal((await abort(f.gate,c)).status,'released');
});

test('abort settlement closes new effect admission while its worker receipt is pending',async t=>{
 let entered,finish;const started=new Promise(r=>entered=r),done=new Promise(r=>finish=r);
 const worker={async request(method,args){if(method==='quiescence.acquire')return {held:true,ownerId:args.ownerId,fenceId:args.context.fenceId};entered();await done;return {ownerId:'media',status:'released',receiptId:'worker',...Object.fromEntries(['commandId','fenceId','instanceId','dataScope'].map(key=>[key,args.context[key]]))}}};
 const f=await fixture(t,{worker:()=>worker}),c=context('pending');await f.gate.participant().acquire(c);
 const settling=abort(f.gate,c);await started;let effects=0;
 await assert.rejects(f.gate.effect(()=>{effects++}),/intake is closed/);await assert.rejects(abort(f.gate,c),/already running/);
 finish();await settling;assert.equal(effects,0);await f.gate.effect(()=>{effects++});assert.equal(effects,1);
});

test('actual process death preserves an original no-worker attempt for exact authenticated abort',async t=>{
 const f=await fixture(t),c=context('killed');f.close();
 // Keep teardown's close handle valid while the child owns the lifetime lease.
 const script=`import {MediaQuiescence} from ${JSON.stringify(new URL('../src/quiescence.js',import.meta.url).href)};const g=new MediaQuiescence(process.argv[1],()=>({counts:{},gaps:[]}),()=>undefined);await g.participant().acquire(JSON.parse(process.argv[2]));console.log('held');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,f.directory,JSON.stringify(c)],{stdio:['ignore','pipe','pipe']});child.stderr.resume();const lines=createInterface({input:child.stdout});
 try{assert.equal((await once(lines,'line'))[0],'held');child.kill('SIGKILL');await once(child,'exit');lines.close();}
 finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}lines.close();}
 f.restart();assert.equal(f.gate.current().state,'unknown');assert.equal((await abort(f.gate,c)).status,'released');assert.equal(f.gate.inspect().intakeClosed,false);
});

const python=process.env.MEDIA_WORKER_PYTHON;
test('partial unwind: conclusive unchanged release survives restart and a distinct abort preserves a newer hold',async t=>{
 const f=await fixture(t),c=context('unwound'),lease=await f.gate.participant().acquire(c);
 await lease.release('unchanged',{kind:'admission-refused'});f.restart();
 await assert.rejects(abort(f.gate,c,{kind:'admission-refused'}),/abort proof/);
 const next=context('after-unwind');await f.gate.participant().acquire(next);
 const held=f.gate.current();f.counts.effects=1;
 await assert.rejects(abort(f.gate,c),/pending or unknown/);f.counts.effects=0;
 const result=await abort(f.gate,c);assert.equal(result.status,'released');
 assert.deepEqual(f.gate.current(),held);assert.equal(f.gate.liveFence,next.fenceId);
 f.restart();assert.deepEqual(await abort(f.gate,c),result);assert.equal(f.gate.current().fenceId,next.fenceId);
 await assert.rejects(abort(f.gate,c,{...proof(c),receiptId:'changed'}),/retained proof/);
 await abort(f.gate,next);
});

test('partial unwind: actual worker release evidence and Node journal preserve newer holds after restart',{skip:!python},async t=>{
 const actual=createPythonWorker({python});t.after(()=>actual.close());let releases=0,aborts=0,available=true;
 const worker={async request(method,args){if(method==='quiescence.release')releases++;if(method==='quiescence.abortAdmission')aborts++;return actual.request(method,args)}};
 const f=await fixture(t,{worker:()=>available?worker:undefined}),c=context('worker-unwound'),lease=await f.gate.participant().acquire(c);
 await lease.release('unchanged',{kind:'admission-refused'});f.restart();
 const next=context('worker-after-unwind');await f.gate.participant().acquire(next);
 const workerHeld=(await actual.request('quiescence.inspect',{})).fence;
 const wr=await actual.request('quiescence.abortAdmission',{ownerId:'media',context:c,proof:proof(c)});
 assert.equal(wr.status,'released');assert.deepEqual((await actual.request('quiescence.inspect',{})).fence,workerHeld);
 const result=await abort(f.gate,c);assert.equal(result.status,'released');
 assert.equal(f.gate.current().fenceId,next.fenceId);assert.equal(f.gate.liveFence,next.fenceId);
 assert.deepEqual((await actual.request('quiescence.inspect',{})).fence,workerHeld);
 f.restart();assert.deepEqual(await abort(f.gate,c),result);assert.equal(releases,1);assert.equal(aborts,0);
 await abort(f.gate,next);
 const retired=context('conclusively-unwound-worker-retired'),retiredLease=await f.gate.participant().acquire(retired);
 await retiredLease.release('unchanged',{kind:'admission-refused'});await actual.close();available=false;f.restart();
 assert.equal((await abort(f.gate,retired)).status,'released');assert.equal(releases,2);assert.equal(aborts,1);
});

test('ready release and missing conclusive unchanged release evidence cannot settle admission abort',async t=>{
 const f=await fixture(t),c=context('ready-release'),lease=await f.gate.participant().acquire(c);
 await lease.release('ready',{verified:true,fenceId:c.fenceId,commandId:c.commandId,dataScope:c.dataScope,outcome:'ready',instanceId:'replacement',receiptId:'ready'});
 f.restart();await assert.rejects(abort(f.gate,c),/settlement is unavailable/);
 const other=await fixture(t),u=context('lost-conclusive-release'),l=await other.gate.participant().acquire(u);
 await l.release('unchanged',{kind:'admission-refused'});
 const retained=JSON.parse(other.gate.db.prepare('SELECT value FROM receipts WHERE id=?').get(u.fenceId).value);
 delete retained.releaseSignature;other.gate.record(retained);other.restart();
 await assert.rejects(abort(other.gate,u),/settlement is unavailable/);
});

test('actual Python worker retains exact abort after lost acquire and abort replies without re-execution',{skip:!python},async t=>{
 const actual=createPythonWorker({python});t.after(()=>actual.close());let acquire=0,aborts=0;
 const worker={async request(method,args){const result=await actual.request(method,args);if(method==='quiescence.acquire'&&++acquire===1)throw Error('acquire reply lost');if(method==='quiescence.abortAdmission'&&++aborts===1)throw Error('abort reply lost');return result}};
 const f=await fixture(t,{worker:()=>worker}),c=context('actual-worker');
 await assert.rejects(f.gate.participant().acquire(c),/reply lost/);await assert.rejects(abort(f.gate,c),/reply lost/);
 assert.equal(f.gate.inspect().intakeClosed,true);f.restart();
 const result=await abort(f.gate,c);assert.equal(result.status,'released');assert.equal(acquire,1);assert.equal(aborts,2);
 assert.equal((await actual.request('quiescence.inspect',{})).intakeClosed,false);
 f.restart();assert.deepEqual(await abort(f.gate,c),result);assert.equal(aborts,2);
});
