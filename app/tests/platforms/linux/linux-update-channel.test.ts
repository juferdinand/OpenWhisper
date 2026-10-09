import assert from "node:assert/strict";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { createLinuxUpdateParentChannel, createLinuxUpdateGuiChannel, LINUX_UPDATE_CHANNEL_FRAME_BYTES,
  LINUX_UPDATE_PROTOCOL, openLinuxUpdateGuiChannel, type LinuxUpdateResponse } from "../../../src/main/linux-update-channel.js";
import { LINUX_RESTART_NONCE, LINUX_RESTART_VERSION } from "../../../src/main/linux-restart.js";
const binding = { currentVersion: "0.3.0", nonce: "a".repeat(64) };
const turn = (): Promise<void> => new Promise((accept) => setImmediate(accept));
const frame = (fields: Record<string, unknown>) => Buffer.from(`${JSON.stringify({ version: 2, ...binding, ...fields })}\n`);
function gate() { let accept!: () => void; const promise = new Promise<void>((yes) => { accept = yes; }); return { promise, accept }; }
async function until(check: () => boolean) { for (let count=0; count<100; count++) { if(check()) return; await turn(); } assert.fail("Expected channel phase was not reached."); }

test("callback-chained commands and retirement settle without publication turns", async () => {
  const [a, b] = duplexPair(), received: LinuxUpdateResponse[] = [], actions: string[] = [];
  const entered = gate(); let chainedInstall: Promise<void> | undefined, retiring: Promise<void> | undefined, acknowledgment: Promise<void> | undefined;
  const parent = createLinuxUpdateParentChannel(a, binding, async (kind) => {
    actions.push(kind); return kind === "check" ? { status: "available", updateVersion: "0.3.1" } : { status: "prepared", updateVersion: "0.3.1" };
  });
  const gui = createLinuxUpdateGuiChannel(b, binding, (response) => {
    received.push(response);
    if (response.type === "state" && response.state.status === "available") {
      chainedInstall = gui.request("install"); void chainedInstall.catch(() => {});
    } else if (response.type === "state" && response.state.status === "prepared") {
      retiring = parent.requestRetirement(); void retiring.catch(() => {});
    } else if (response.type === "retire") {
      entered.accept(); acknowledgment = gui.acknowledgeRetired(); void acknowledgment.catch(() => {});
    }
  });
  try {
    await assert.rejects(gui.acknowledgeRetired(), { code: "INVALID_STATE" });
    await gui.request("check"); await entered.promise;
    assert.deepEqual(await parent.retirement, { updateVersion: "0.3.1" });
    await chainedInstall; await retiring; await acknowledgment;
    assert.deepEqual(actions, ["check", "install"]);
    assert.deepEqual(received.map((response) => response.type === "state" ? response.state.status : response.type),
      ["checking", "available", "preparing", "prepared", "retire"]);
    assert.equal(a.closed, true); assert.equal(b.closed, true);
  } finally { await Promise.all([parent.close(), gui.close()]); }
});

test("ordinary EOF grants none and living GUI has no idle timer", async t=>{
 const [a,b]=duplexPair(),parent=createLinuxUpdateParentChannel(a,binding,async()=>({status:"idle"}));
 const gui=createLinuxUpdateGuiChannel(b,binding,()=>{});t.mock.timers.enable({apis:["setTimeout"]});t.mock.timers.tick(86_400_000);
 assert.equal(a.destroyed,false);assert.equal(b.destroyed,false);gui.quit();assert.equal(await parent.retirement,undefined);
});
test("cancel aborts one action but retains original settlement",async()=>{
 const [a,b]=duplexPair(),entered=gate(),release=gate(),received:LinuxUpdateResponse[]=[];let signal:AbortSignal|undefined;
 const parent=createLinuxUpdateParentChannel(a,binding,async(_kind,cancellation)=>{signal=cancellation;entered.accept();await release.promise;return {status:"prepared",updateVersion:"0.3.1"};});
 const gui=createLinuxUpdateGuiChannel(b,binding,response=>{received.push(response);});
 try{await gui.request("install");await entered.promise;await gui.request("cancel");await until(()=>signal?.aborted===true);
 await assert.rejects(gui.request("check"),{code:"INVALID_STATE"});assert.equal(received.some(x=>x.type==="state"&&x.state.status==="failed"),false);
 release.accept();await until(()=>received.some(x=>x.type==="state"&&x.state.status==="failed"&&x.state.code==="CANCELLED"));gui.quit();assert.equal(await parent.retirement,undefined);
 }finally{release.accept();await parent.close();await gui.close();}
});
test("disconnect retains accepted original action through its late settlement",async()=>{
 const [a,b]=duplexPair(),entered=gate(),release=gate();let aborted=false,closed=false;
 const parent=createLinuxUpdateParentChannel(a,binding,async(_kind,signal)=>{signal.addEventListener("abort",()=>{aborted=true;});entered.accept();await release.promise;return {status:"idle"};});
 const gui=createLinuxUpdateGuiChannel(b,binding,()=>{});await gui.request("check");await entered.promise;
 const closing=parent.close().then(()=>{closed=true;});await turn();assert.equal(aborted,true);assert.equal(closed,false);
 release.accept();await closing;await gui.close();await assert.rejects(parent.retirement,{code:"CHANNEL_FAILED",message:"CHANNEL_FAILED"});
});
test("fragmentation accepts exact frames; foreign, partial, oversized and extra-key commands refuse",async()=>{
 for(const bytes of [frame({type:"check",nonce:"b".repeat(64)}),frame({type:"check",currentVersion:"0.2.5"}),frame({type:"check",path:"/private/not-authority"}),frame({type:"retired"}),frame({type:"unknown"}),frame({type:"check",version:1}),frame({type:"check"}).subarray(0,-1),Buffer.from([255,10]),Buffer.alloc(LINUX_UPDATE_CHANNEL_FRAME_BYTES+1,65)]){
 const [a,b]=duplexPair(),parent=createLinuxUpdateParentChannel(a,binding,async()=>({status:"idle"}));b.resume();b.end(bytes);await assert.rejects(parent.retirement,{code:"CHANNEL_FAILED",message:"CHANNEL_FAILED"});b.destroy();}
 const [a,b]=duplexPair();let calls=0;const parent=createLinuxUpdateParentChannel(a,binding,async()=>{calls++;return {status:"idle"};});
 b.resume();const bytes=frame({type:"check"});b.write(bytes.subarray(0,7));b.write(bytes.subarray(7));await until(()=>calls===1);await turn();b.end();assert.equal(await parent.retirement,undefined);
});
test("overlap and old prepared versions poison while retaining private callbacks",async()=>{
 const [a,b]=duplexPair(),release=gate(),entered=gate();const parent=createLinuxUpdateParentChannel(a,binding,async()=>{entered.accept();await release.promise;return {status:"idle"};});
 b.resume();b.write(frame({type:"check"}));await entered.promise;b.write(frame({type:"install"}));await turn();release.accept();await assert.rejects(parent.retirement,{code:"CHANNEL_FAILED"});b.destroy();
 const [c,d]=duplexPair(),invalid=createLinuxUpdateParentChannel(c,binding,async()=>({status:"prepared",updateVersion:"0.3.0"}));d.resume();d.write(frame({type:"install"}));await assert.rejects(invalid.retirement,{code:"CHANNEL_FAILED",message:"CHANNEL_FAILED"});d.destroy();
});

test("GUI rejects unsolicited state, unprepared retirement and action-mismatched replies",async()=>{
 for(const response of [{type:"state",state:{status:"idle"}},{type:"retire",updateVersion:"0.3.1"}]){
  const [a,b]=duplexPair();let received=false;const gui=createLinuxUpdateGuiChannel(b,binding,()=>{received=true;});
  a.write(frame(response));await until(()=>b.destroyed);assert.equal(received,false);await gui.close();a.destroy();
 }
 const [a,b]=duplexPair();a.resume();let received=false;const gui=createLinuxUpdateGuiChannel(b,binding,()=>{received=true;});
 await gui.request("check");a.write(frame({type:"state",state:{status:"prepared",updateVersion:"0.3.1"}}));await until(()=>b.destroyed);assert.equal(received,false);await gui.close();a.destroy();
});
test("invalid binding exposes only a fixed category before attaching original stream",()=>{
 const [a,b]=duplexPair();assert.throws(()=>createLinuxUpdateParentChannel(a,{...binding,nonce:"PRIVATE INVALID VALUE"},async()=>({status:"idle"})),{code:"INVALID_FRAME",message:"INVALID_FRAME"});
 a.destroy();b.destroy();
});

test("original close settles an unread outgoing write without starting its action", async () => {
  const [a, b] = duplexPair({ highWaterMark: 1 }); let calls = 0;
  const parent = createLinuxUpdateParentChannel(a, binding, async () => { calls++; return { status: "idle" }; });
  b.write(frame({ type: "check" })); await turn();
  assert.equal(calls, 0); assert.ok(a.writableLength > 0);
  await parent.close(); await assert.rejects(parent.retirement, { code: "CHANNEL_FAILED", message: "CHANNEL_FAILED" });
  assert.equal(calls, 0); b.destroy();
});

test("prepared publication callback waits for the original terminal write and can initiate retirement", async () => {
  const [a, b] = duplexPair({ highWaterMark: 1 }), release = gate();
  let preparing = false, published = 0, retiring: Promise<void> | undefined;
  const parent = createLinuxUpdateParentChannel(a, binding, async () => {
    await release.promise; return { status: "prepared", updateVersion: "0.3.1" };
  }, () => { published++; retiring = parent.requestRetirement(); void retiring.catch(() => {}); });
  const gui = createLinuxUpdateGuiChannel(b, binding, (response) => {
    if (response.type === "state" && response.state.status === "preparing") { preparing = true; b.pause(); }
    if (response.type === "retire") void gui.acknowledgeRetired().catch(() => {});
  });
  try {
    await gui.request("install"); await until(() => preparing); release.accept();
    await until(() => a.writableLength > 0); assert.equal(published, 0);
    b.resume(); assert.deepEqual(await parent.retirement, { updateVersion: "0.3.1" });
    await retiring; await gui.closed; assert.equal(published, 1);
  } finally { release.accept(); await Promise.all([parent.close(), gui.close()]); }
});

test("GUI closed waits for both original directions and rejects a partial response", async () => {
  const [a, b] = duplexPair(); a.resume();
  const gui = createLinuxUpdateGuiChannel(b, binding, () => {});
  let closed = false; void gui.closed.then(() => { closed = true; });
  gui.quit(); await until(() => a.readableEnded); assert.equal(closed, false);
  a.end(); await gui.closed; assert.equal(closed, true);
  const [c, d] = duplexPair(), malformed = createLinuxUpdateGuiChannel(d, binding, () => {});
  c.end(frame({ type: "state", state: { status: "idle" } }).subarray(0, -1));
  await assert.rejects(malformed.closed, { code: "CHANNEL_FAILED", message: "CHANNEL_FAILED" }); c.destroy();
});

test("inherited GUI opener preserves absent V2 hints and consumes invalid V2 without adopting fd3", () => {
  const keys = [LINUX_UPDATE_PROTOCOL, LINUX_RESTART_NONCE, LINUX_RESTART_VERSION], saved = keys.map(key => process.env[key]);
  try {
    delete process.env[LINUX_UPDATE_PROTOCOL]; process.env[LINUX_RESTART_NONCE] = binding.nonce; process.env[LINUX_RESTART_VERSION] = binding.currentVersion;
    assert.equal(openLinuxUpdateGuiChannel(binding.currentVersion, () => {}), undefined);
    assert.equal(process.env[LINUX_RESTART_NONCE], binding.nonce); assert.equal(process.env[LINUX_RESTART_VERSION], binding.currentVersion);
    for (const hints of [{ protocol: "1", nonce: binding.nonce, version: binding.currentVersion },
      { protocol: "2", nonce: "PRIVATE INVALID VALUE", version: binding.currentVersion },
      { protocol: "2", nonce: binding.nonce, version: "0.2.5" }]) {
      process.env[LINUX_UPDATE_PROTOCOL] = hints.protocol; process.env[LINUX_RESTART_NONCE] = hints.nonce; process.env[LINUX_RESTART_VERSION] = hints.version;
      assert.throws(() => openLinuxUpdateGuiChannel(binding.currentVersion, () => {}), { code: "CHANNEL_FAILED", message: "CHANNEL_FAILED" });
      assert.ok(keys.every(key => process.env[key] === undefined));
    }
  } finally { keys.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
});
