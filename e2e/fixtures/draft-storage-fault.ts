import type {Page} from "@playwright/test";

export async function rawDraftDatabase(page:Page){
  return page.evaluate(()=>new Promise<Record<string,{keyPath:string|string[];autoIncrement:boolean;indices:{name:string;keyPath:string|string[];unique:boolean;multiEntry:boolean}[];rows:unknown[]}>>((resolve,reject)=>{
    const request=indexedDB.open("taco-oasis-paint-drafts");request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,tx=db.transaction([...db.objectStoreNames]),result:Record<string,{keyPath:string|string[];autoIncrement:boolean;indices:{name:string;keyPath:string|string[];unique:boolean;multiEntry:boolean}[];rows:unknown[]}>={};
      for(const name of db.objectStoreNames){const store=tx.objectStore(name),read=store.getAll();read.onsuccess=()=>{result[name]={keyPath:store.keyPath!,autoIncrement:store.autoIncrement,indices:[...store.indexNames].map(name=>{const index=store.index(name);return {name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};}),rows:read.result};};}
      tx.oncomplete=()=>{db.close();resolve(result);};tx.onabort=()=>{db.close();reject(tx.error);};
    };
  }));
}

/** Rebuild only this disposable browser's version-1 fixture, retaining every original row. */
export async function faultDraftIndexes(page:Page,mode:"missing"|"wrong"|"unique"|"multiEntry"|"extra"){
  const raw=await rawDraftDatabase(page);
  await page.evaluate(async({raw,mode})=>{
    await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase("taco-oasis-paint-drafts");r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error("fixture connection still open"));});
    await new Promise<void>((resolve,reject)=>{
      const r=indexedDB.open("taco-oasis-paint-drafts",1);r.onerror=()=>reject(r.error);
      r.onupgradeneeded=()=>{
        for(const [name,definition] of Object.entries(raw)){
          const store=r.result.createObjectStore(name,{keyPath:definition.keyPath,autoIncrement:definition.autoIncrement});
          for(const index of definition.indices){
            if(mode==="missing"&&index.name==="scope")continue;
            const key=index.name==="scope"&&(mode==="wrong"||mode==="multiEntry")?"date":index.keyPath;
            store.createIndex(index.name,key,{unique:mode==="unique"&&name==="heads"||index.unique,multiEntry:mode==="multiEntry"&&index.name==="scope"||index.multiEntry});
          }
          if(mode==="extra"&&name==="clientMeta")store.createIndex("future","value");
          for(const row of definition.rows)store.add(row);
        }
      };r.onsuccess=()=>{r.result.close();resolve();};
    });
  },{raw,mode});
}
