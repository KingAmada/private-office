const CACHE='private-office-static-v15';
const ASSETS=['./','./index.html','./styles.css','./ui-polish.css','./workspace.css','./batch-upload.css','./vault-ui.css','./vault-ui.js','./app.js','./workspace.js','./batch-upload.js','./config.js','./file-controls.js','./manifest.webmanifest','./favicon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});
