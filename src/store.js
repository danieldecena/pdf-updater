// ============================================================================
// store.js — version history in this browser (IndexedDB) and a tiny zip writer.
// Every call is guarded: private windows / blocked storage just turn history off.
// ============================================================================
const Store = (() => {
  const DB='pdf-change-updater', STORE='versions';
  let dbp=null;
  function open(){
    if (dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      try{
        if (!window.indexedDB) return rej(new Error('no indexedDB'));
        const rq=indexedDB.open(DB,1);
        rq.onupgradeneeded=()=>{ const db=rq.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true}); };
        rq.onsuccess=()=>res(rq.result);
        rq.onerror=()=>rej(rq.error||new Error('open failed'));
        rq.onblocked=()=>rej(new Error('blocked'));
      }catch(e){ rej(e); }
    });
    dbp.catch(()=>{ dbp=null; });
    return dbp;
  }
  function tx(mode, fn){
    return open().then(db=>new Promise((res,rej)=>{
      const t=db.transaction(STORE,mode), s=t.objectStore(STORE); let out;
      Promise.resolve(fn(s)).then(v=>{ out=v; });
      t.oncomplete=()=>res(out); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error||new Error('aborted'));
    }));
  }
  const req = r => new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  async function available(){ try{ await open(); return true; }catch{ return false; } }
  async function save(rec){
    try{ if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{}); }catch{}
    return tx('readwrite', s=>req(s.add(rec)));
  }
  // list without the heavy file bytes
  async function list(){
    return tx('readonly', s=>new Promise((res,rej)=>{
      const out=[]; const cur=s.openCursor(null,'prev');
      cur.onsuccess=()=>{ const c=cur.result; if(!c) return res(out); const v=c.value;
        out.push({ id:v.id, name:v.name, savedAt:v.savedAt, applied:v.applied, summary:v.summary, sizeOriginal:v.original?.byteLength||0, sizeUpdated:v.updated?.byteLength||0 }); c.continue(); };
      cur.onerror=()=>rej(cur.error);
    }));
  }
  async function get(id){ return tx('readonly', s=>req(s.get(id))); }
  async function remove(id){ return tx('readwrite', s=>req(s.delete(id))); }
  async function usage(){ try{ const e=await navigator.storage.estimate(); return e; }catch{ return null; } }

  // ---- zip (stored, no compression; PDFs are already compressed) ----
  const CRC=(()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
  function crc32(u8){ let c=0xFFFFFFFF; for(let i=0;i<u8.length;i++) c=CRC[(c^u8[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
  function zip(files){   // [{name, data:Uint8Array}]
    const enc=new TextEncoder(), parts=[], central=[]; let offset=0;
    const d=new Date(), dosTime=(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1), dosDate=((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate();
    for (const f of files){
      const name=enc.encode(f.name), data=f.data, crc=crc32(data);
      const h=new DataView(new ArrayBuffer(30));
      h.setUint32(0,0x04034b50,true); h.setUint16(4,20,true); h.setUint16(6,0x0800,true); h.setUint16(8,0,true);
      h.setUint16(10,dosTime,true); h.setUint16(12,dosDate,true); h.setUint32(14,crc,true); h.setUint32(18,data.length,true); h.setUint32(22,data.length,true);
      h.setUint16(26,name.length,true); h.setUint16(28,0,true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c=new DataView(new ArrayBuffer(46));
      c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x0800,true); c.setUint16(10,0,true);
      c.setUint16(12,dosTime,true); c.setUint16(14,dosDate,true); c.setUint32(16,crc,true); c.setUint32(20,data.length,true); c.setUint32(24,data.length,true);
      c.setUint16(28,name.length,true); c.setUint32(42,offset,true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30+name.length+data.length;
    }
    const cdSize=central.reduce((a,p)=>a+p.length,0);
    const e=new DataView(new ArrayBuffer(22));
    e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true); e.setUint32(12,cdSize,true); e.setUint32(16,offset,true);
    return new Blob([...parts,...central,new Uint8Array(e.buffer)],{type:'application/zip'});
  }
  return { available, save, list, get, remove, usage, zip, crc32 };
})();
