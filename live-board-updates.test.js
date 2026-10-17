const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const updates=require('./live-board-updates.js');
const TOPIC='player-live:'+'a'.repeat(64), OTHER='player-live:'+'b'.repeat(64);
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function clock(){
  let now=Date.parse('2026-10-18T04:00:00Z'), id=0; const tasks=new Map();
  return { now:()=>now, setTimer:(fn,ms)=>{tasks.set(++id,{fn,at:now+ms});return id;},clearTimer:key=>tasks.delete(key),
    async advance(ms){const end=now+ms;let turns=0;
      while(true){const next=[...tasks.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        if(!next)break;if(++turns>10000)throw new Error('Timer loop');now=next[1].at;tasks.delete(next[0]);next[1].fn();await settle();}
      now=end;await settle();
    },count:()=>tasks.size,
  };
}
function fixture({metadata=true,lifetime=86400000,status='active',fetcher}={}){
  const time=clock(), ends=time.now()+lifetime, channels=[],snapshots=[],errors=[],calls=[];
  let unavailable=0,hidden=false,online=true;
  const snapshot=()=>({generatedAt:new Date(time.now()).toISOString(),session:{status},players:['Authoritative Player'],
    ...(metadata?{liveUpdates:{mode:'broadcast',topic:TOPIC,reconcileMs:60000,expiresAt:new Date(ends).toISOString()}}:{})});
  const controller=updates.create({now:time.now,setTimer:time.setTimer,clearTimer:time.clearTimer,
    isHidden:()=>hidden,isOnline:()=>online,
    fetchSnapshot:()=>{calls.push(time.now());return fetcher?fetcher(snapshot,calls.length):Promise.resolve(snapshot());},
    onSnapshot:value=>snapshots.push(value),onError:error=>errors.push(error),onUnavailable:()=>{unavailable++;},
    subscribe(topic,handlers){const channel={topic,handlers,removed:0};channels.push(channel);return()=>{channel.removed++;};},
  });
  return {time,controller,channels,snapshots,errors,calls,snapshot,get unavailable(){return unavailable;},
    set hidden(value){hidden=value;},set online(value){online=value;},
    async start(join=true){controller.start();await time.advance(0);if(join&&channels.length){channels.at(-1).handlers.status('SUBSCRIBED');await time.advance(0);}},
  };
}

test('healthy subscriptions resync on join and reduce quiet snapshot reads to once a minute, including completed boards',async()=>{
  for(const status of ['active','completed']){
    const f=fixture({status});await f.start();
    assert.equal(f.calls.length,2,'initial snapshot plus join-race resync');
    await f.time.advance(59999);assert.equal(f.calls.length,2);
    await f.time.advance(1);assert.equal(f.calls.length,3);
    await f.time.advance(3540000);assert.equal(f.calls.length,62,'60 backup reads per healthy viewer-hour');
    f.controller.dispose();
  }
});

test('old backend, unavailable transport, and absent SUBSCRIBED keep three-second fallback',async()=>{
  const legacy=fixture({metadata:false});await legacy.start();await legacy.time.advance(9000);
  assert.equal(legacy.calls.length,4);assert.equal(legacy.channels.length,0);
  const joining=fixture();await joining.start(false);await joining.time.advance(6000);
  assert.equal(joining.calls.length,3);
  const failed=fixture();await failed.start();failed.channels[0].handlers.status('CHANNEL_ERROR');
  await failed.time.advance(6000);assert.equal(failed.calls.length,4);
  failed.channels[0].handlers.status('SUBSCRIBED');await failed.time.advance(0);
  assert.equal(failed.calls.length,5);await failed.time.advance(59999);assert.equal(failed.calls.length,5);
});

test('broadcast payloads never render, bursts coalesce, and sustained hints cannot postpone reads indefinitely',async()=>{
  const f=fixture();await f.start();
  const hint=f.channels[0].handlers.changed;
  for(let i=0;i<100;i++)hint({players:['FORGED'],session:{status:'completed'}});
  await f.time.advance(2999);assert.equal(f.calls.length,2);
  await f.time.advance(1);assert.equal(f.calls.length,3);
  for(let i=0;i<200;i++){hint({players:['FORGED']});await f.time.advance(50);}
  assert.ok(f.calls.length>=6,'continuous hints still produce bounded fresh reads');
  assert.ok(f.calls.length<=7,'untrusted hints cannot exceed one snapshot read per three seconds');
  assert.ok(f.snapshots.every(value=>value.players[0]==='Authoritative Player'));
  for(let i=3;i<f.calls.length;i++)assert.ok(f.calls[i]-f.calls[i-1]>=3000);
});

test('hints arriving during an in-flight RPC retain one follow-up read',async()=>{
  let resolve;
  const f=fixture({fetcher:(snapshot,count)=>count===3?new Promise(done=>{resolve=()=>done(snapshot());}):Promise.resolve(snapshot())});
  await f.start();f.channels[0].handlers.changed();await f.time.advance(3000);
  assert.equal(f.calls.length,3);
  for(let i=0;i<20;i++)f.channels[0].handlers.changed();
  await f.time.advance(4000);assert.equal(f.calls.length,3,'no overlapping RPC');
  resolve();await settle();await f.time.advance(150);
  assert.equal(f.calls.length,4,'dirty event survived the completed read');
  await f.time.advance(3000);assert.equal(f.calls.length,4,'the burst only adds one follow-up');
});

test('hidden and offline views stop reads and subscriptions, then immediately resync on return',async()=>{
  const f=fixture();await f.start();const old=f.channels[0];
  f.hidden=true;f.controller.pause();await f.time.advance(120000);
  assert.equal(f.calls.length,2);assert.equal(old.removed,1);
  old.handlers.changed();old.handlers.status('SUBSCRIBED');await f.time.advance(0);assert.equal(f.calls.length,2);
  f.hidden=false;f.controller.wake();await f.time.advance(0);assert.equal(f.calls.length,3);assert.equal(f.channels.length,2);
  f.online=false;f.controller.pause();await f.time.advance(120000);assert.equal(f.calls.length,3);
  f.online=true;f.controller.wake();await f.time.advance(0);assert.equal(f.calls.length,4);
});

test('null snapshots and expiration clear the board, unsubscribe and stop all polling',async()=>{
  let resolve;
  const revoked=fixture({fetcher:(snapshot,count)=>Promise.resolve(count>=3?null:snapshot())});
  await revoked.start();revoked.channels[0].handlers.changed();await revoked.time.advance(3000);
  assert.equal(revoked.unavailable,1);assert.equal(revoked.channels[0].removed,1);
  await revoked.time.advance(120000);assert.equal(revoked.calls.length,3);
  const expired=fixture({lifetime:5000,fetcher:(snapshot,count)=>count>=3?new Promise(done=>{resolve=()=>done(snapshot());}):Promise.resolve(snapshot())});
  await expired.start();expired.channels[0].handlers.changed();await expired.time.advance(3000);
  await expired.time.advance(2000);assert.equal(expired.unavailable,1);assert.equal(expired.channels[0].removed,1);
  resolve();await settle();assert.equal(expired.snapshots.length,2,'late response cannot repaint expired data');
  await expired.time.advance(120000);assert.equal(expired.calls.length,3);
});

test('lost metadata removes the channel, restored metadata reconnects, and old-topic callbacks are ignored',async()=>{
  const f=fixture({fetcher:(snapshot,count)=>{
    const data=snapshot();if(count===3)delete data.liveUpdates;else if(count>=4)data.liveUpdates.topic=OTHER;
    return Promise.resolve(data);
  }});
  await f.start();const original=f.channels[0];original.handlers.changed();await f.time.advance(3000);
  assert.equal(original.removed,1);assert.equal(f.calls.length,3);
  await f.time.advance(3000);assert.equal(f.calls.length,4);assert.equal(f.channels[1].topic,OTHER);
  original.handlers.changed();original.handlers.status('SUBSCRIBED');await f.time.advance(0);assert.equal(f.calls.length,4);
  f.channels[1].handlers.status('SUBSCRIBED');await f.time.advance(0);assert.equal(f.calls.length,5);
});

test('RPC failures back off while socket-only disconnects keep three-second fallback',async()=>{
  const f=fixture({fetcher:(snapshot,count)=>count===3?Promise.reject(new Error('network')):Promise.resolve(snapshot())});
  await f.start();f.channels[0].handlers.changed();await f.time.advance(3000);
  assert.equal(f.errors.length,1);await f.time.advance(3000);assert.equal(f.calls.length,3);
  await f.time.advance(3000);assert.equal(f.calls.length,4);
  f.channels[0].handlers.status('CLOSED');await f.time.advance(3000);
  assert.equal(f.calls.length,5);assert.equal(f.channels.length,2);
});

test('persistent RPC failures back off to a minute despite hints, and explicit refresh can recover immediately',async()=>{
  let recover=false;
  const f=fixture({fetcher:snapshot=>recover?Promise.resolve(snapshot()):Promise.reject(new Error('service unavailable'))});
  await f.start();const start=f.calls[0];
  await f.time.advance(6000);await f.time.advance(12000);await f.time.advance(24000);
  assert.deepEqual(f.calls.map(t=>t-start),[0,6000,18000,42000]);
  await f.time.advance(59999);assert.equal(f.calls.length,4);
  await f.time.advance(1);assert.equal(f.calls.length,5);
  recover=true;f.controller.refresh();await f.time.advance(0);
  assert.equal(f.calls.length,6);assert.equal(f.snapshots.length,1);
  f.channels[0].handlers.status('SUBSCRIBED');await f.time.advance(0);
  const before=f.calls.length;await f.time.advance(59999);assert.equal(f.calls.length,before);

  let fail=false;
  const hinted=fixture({fetcher:snapshot=>fail?Promise.reject(new Error('temporary')):Promise.resolve(snapshot())});
  await hinted.start();fail=true;hinted.channels[0].handlers.changed();await hinted.time.advance(3000);
  const calls=hinted.calls.length;
  for(let i=0;i<59;i++){hinted.channels[0].handlers.changed();await hinted.time.advance(100);}
  assert.equal(hinted.calls.length,calls,'hints cannot bypass the first six-second failure delay');
  await hinted.time.advance(100);assert.equal(hinted.calls.length,calls+1);
});

test('modern board wiring loads the controller before the player script and uses only invalidation hints',()=>{
  const html=fs.readFileSync('player-live.html','utf8'),source=fs.readFileSync('player-live.js','utf8');
  assert.ok(html.indexOf('live-board-updates.js')<html.indexOf('src="player-live.js'));
  assert.match(source,/fetchSnapshot: \(\) => DB\.getPublicOpenPlayGameLiveBoard\(state\.token\)/);
  assert.match(source,/\.on\("broadcast", \{ event: "changed" \}, \(\) => handlers\.changed\(\)\)/);
  assert.doesNotMatch(source,/postgres_changes|function schedulePoll|setTimeout\(fetchSnapshot/);
});
