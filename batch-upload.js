(() => {
'use strict';
const C=window.PRIVATE_OFFICE_CONFIG||{};
const API=String(C.API_URL||'').replace(/\/$/,'');
const SESSION_KEY='private_office_session_v1';
const SIMPLE_BYTES=(Number(C.SIMPLE_UPLOAD_MB)||12)*1048576;
const MAX_BYTES=(Number(C.MAX_UPLOAD_GB)||5)*1073741824;
const DEFAULT_CHUNK=(Number(C.MULTIPART_CHUNK_MB)||8)*1048576;
const CONCURRENCY=2;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmt=n=>{n=Number(n||0);if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;if(n<1073741824)return`${(n/1048576).toFixed(1)} MB`;return`${(n/1073741824).toFixed(2)} GB`};
const uid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
const state={items:[],running:false,cancelled:false,active:new Map(),note:'',startedAt:0};
function token(){return localStorage.getItem(SESSION_KEY)||''}
function toast(t){const x=$('#toast');if(!x)return;x.textContent=t;x.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>x.classList.remove('show'),3300)}
function stageLabel(i){return i.status==='queued'?'Waiting':i.status==='preparing'?'Preparing secure upload…':i.status==='uploading'?`Uploading ${Math.round(i.progress)}%`:i.status==='processing'?'AI filing & finalizing…':i.status==='done'?'Remembered':i.status==='error'?'Needs attention':i.status==='cancelled'?'Cancelled':'Waiting'}
function modal(){let m=$('#batchUploadModal');if(m)return m;m=document.createElement('div');m.id='batchUploadModal';m.className='buOverlay hidden';m.innerHTML=`
  <section class="buModal" role="dialog" aria-modal="true" aria-labelledby="buTitle">
    <div class="buHandle"></div>
    <header class="buHead">
      <div class="buTitleBlock"><span class="buEyebrow">PRIVATE OFFICE INBOX</span><h2 id="buTitle">Add to memory</h2><p id="buSubtitle">Choose files and Private Office will read, rename and file each one.</p></div>
      <button id="buClose" class="buIcon" aria-label="Close">×</button>
    </header>
    <div id="buProgressWrap" class="buProgressWrap hidden">
      <div class="buProgressTop"><div><b id="buProgressTitle">Uploading</b><span id="buProgressText">0 of 0 remembered</span></div><strong id="buPercent">0%</strong></div>
      <div class="buOverall"><i id="buOverallBar"></i></div>
    </div>
    <div class="buBody">
      <label id="buDrop" class="buDrop"><input id="buMore" type="file" multiple hidden><span class="buDropIcon">＋</span><div><b>Add files</b><small>Choose several at once or drop them here · up to ${Number(C.MAX_UPLOAD_GB)||5} GB each</small></div></label>
      <label class="buNote"><span>Context for these files <em>optional</em></span><textarea id="buNote" rows="2" placeholder="e.g. These are the latest documents from ABC Holdings"></textarea></label>
      <div class="buQueueHead"><b id="buCount">0 files</b><button id="buClear" type="button">Clear all</button></div>
      <div id="buList" class="buList"></div>
    </div>
    <footer class="buFoot"><button id="buCancel" class="buButton buSecondary">Cancel</button><button id="buStart" class="buButton buPrimary">Upload files</button><button id="buFiles" class="buButton buPrimary hidden">Open Files</button></footer>
  </section>`;document.body.appendChild(m);bindModal();return m}
function bindModal(){
  $('#buClose').onclick=()=>{if(!state.running)close()};
  $('#buCancel').onclick=()=>state.running?cancelAll():close();
  $('#buStart').onclick=start;
  $('#buFiles').onclick=()=>{close(true);document.querySelector('[data-nav="memory"]')?.click()};
  $('#buClear').onclick=()=>{if(!state.running){state.items=[];$('#buProgressWrap').classList.add('hidden');$('#buSubtitle').textContent='Choose files and Private Office will read, rename and file each one.';render()}};
  $('#buMore').onchange=e=>{addFiles(e.target.files);e.target.value=''};
  const drop=$('#buDrop');
  ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();if(!state.running)drop.classList.add('drag')}));
  ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag')}));
  drop.addEventListener('drop',e=>{if(!state.running)addFiles(e.dataTransfer.files)});
  $('#buList').onclick=e=>{
    const remove=e.target.closest('[data-remove]');
    if(remove&&!state.running){state.items=state.items.filter(x=>x.id!==remove.dataset.remove);render();return}
    const retry=e.target.closest('[data-retry]');
    if(retry&&!state.running){const item=state.items.find(x=>x.id===retry.dataset.retry);if(item){cleanupMultipart(item);item.status='queued';item.error='';item.progress=0;item.result=null;item.uploadSession=null;render()}}
  };
}
function open(files){modal();const text=$('#messageInput')?.value?.trim()||'';$('#buNote').value=text;$('#attachmentPreview')?.classList.add('hidden');$('#batchUploadModal').classList.remove('hidden');document.body.classList.add('buOpen');addFiles(files)}
function close(force=false){if(state.running&&!force)return;$('#batchUploadModal')?.classList.add('hidden');document.body.classList.remove('buOpen');if(!state.running){state.items=[];state.cancelled=false;$('#buProgressWrap')?.classList.add('hidden');$('#buSubtitle').textContent='Choose files and Private Office will read, rename and file each one.';render()}}
function addFiles(fileList){const files=[...(fileList||[])];if(!files.length)return;for(const file of files){const key=`${file.name}|${file.size}|${file.lastModified}`;if(state.items.some(x=>x.key===key))continue;const oversize=file.size>MAX_BYTES;state.items.push({id:uid(),key,file,name:file.name,size:file.size,oversize,status:oversize?'error':'queued',error:oversize?`Larger than ${Number(C.MAX_UPLOAD_GB)||5} GB`:'' ,progress:0,result:null,uploadSession:null,large:file.size>SIMPLE_BYTES})}render()}
function barPercent(i){if(i.status==='done')return 100;if(i.status==='processing')return Math.max(94,i.progress);if(i.status==='preparing')return 2;if(i.status==='error'||i.status==='cancelled')return i.progress||0;return Math.min(92,i.progress*.92)}
function render(){if(!$('#batchUploadModal'))return;const list=$('#buList'),n=state.items.length,hasQueued=state.items.some(i=>i.status==='queued'),hasDone=state.items.some(i=>i.status==='done'),hasFinished=state.items.some(i=>['done','error','cancelled'].includes(i.status));$('#buCount').textContent=`${n} file${n===1?'':'s'}`;$('#buClear').classList.toggle('hidden',!n||state.running);$('#buStart').disabled=state.running||!hasQueued;$('#buStart').classList.toggle('hidden',state.running||!hasQueued);$('#buStart').textContent=n===1?'Upload & remember':'Upload & remember all';$('#buFiles').classList.toggle('hidden',state.running||!hasDone);$('#buCancel').textContent=state.running?'Cancel uploads':hasFinished?'Close':'Cancel';$('#buClose').disabled=state.running;$('#buClose').style.opacity=state.running?'.35':'1';$('#buDrop').classList.toggle('disabled',state.running);$('#buNote').disabled=state.running;$('#buMore').disabled=state.running;
  list.innerHTML=n?state.items.map(i=>`<article class="buRow bu-${i.status}">
    <div class="buFileIcon">${esc((i.name.split('.').pop()||'FILE').slice(0,4).toUpperCase())}</div>
    <div class="buFileMain"><div class="buFileTop"><b title="${esc(i.name)}">${esc(i.result?.name||i.name)}</b><span>${fmt(i.size)}</span></div><small>${esc(i.error||stageLabel(i))}${i.large&&i.status==='queued'?' · chunked upload':''}</small><div class="buBar"><i style="width:${barPercent(i)}%"></i></div>${i.result?.category?`<em>${esc([i.result.category,i.result.entity_name,i.result.document_type].filter(Boolean).join(' → '))}</em>`:''}</div>
    <div class="buRowAction">${!state.running&&((i.status==='error'&&!i.oversize)||i.status==='cancelled')?`<button data-retry="${i.id}">Retry</button>`:!state.running&&i.status!=='done'?`<button data-remove="${i.id}" aria-label="Remove">×</button>`:i.status==='done'?'<span>✓</span>':i.status==='processing'||i.status==='preparing'?'<span class="buSpin">◌</span>':''}</div>
  </article>`).join(''):`<div class="buEmpty"><span>⇧</span><b>No files selected yet</b><small>Add documents, photos, spreadsheets, PDFs and more.</small></div>`;updateOverall()}
function updateOverall(){if(!$('#batchUploadModal'))return;const n=state.items.length,done=state.items.filter(i=>i.status==='done').length,failed=state.items.filter(i=>i.status==='error').length,cancelled=state.items.filter(i=>i.status==='cancelled').length,active=state.items.filter(i=>['preparing','uploading','processing'].includes(i.status)).length;const value=n?Math.round(state.items.reduce((sum,i)=>sum+barPercent(i),0)/n):0;$('#buOverallBar').style.width=`${value}%`;$('#buPercent').textContent=`${value}%`;$('#buProgressText').textContent=`${done} of ${n} remembered${failed?` · ${failed} failed`:''}${cancelled?` · ${cancelled} cancelled`:''}`;$('#buProgressTitle').textContent=state.running?(active?'Uploading and organizing':'Finishing…'):(done===n&&n?'Everything remembered':failed||cancelled?'Upload finished with issues':'Ready')}
function paint(){render()}
function smallUpload(item,note){return new Promise(resolve=>{const xhr=new XMLHttpRequest();state.active.set(item.id,xhr);item.status='uploading';item.progress=0;paint();const fd=new FormData();fd.append('text',note);fd.append('file',item.file,item.file.name);xhr.open('POST',`${API}/api/message`,true);xhr.setRequestHeader('Authorization',`Bearer ${token()}`);xhr.upload.onprogress=e=>{if(e.lengthComputable){item.progress=Math.min(100,e.loaded/e.total*100);paint()}};xhr.upload.onload=()=>{if(item.status==='uploading'){item.status='processing';item.progress=100;paint()}};xhr.onload=()=>{state.active.delete(item.id);let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300){item.status='done';item.progress=100;item.result=d.file||null;item.error=''}else{item.status='error';item.error=d.error||`Upload failed (${xhr.status})`}paint();resolve()};xhr.onerror=()=>{state.active.delete(item.id);item.status='error';item.error='Network error — try again';paint();resolve()};xhr.onabort=()=>{state.active.delete(item.id);item.status='cancelled';item.error='Cancelled';paint();resolve()};xhr.send(fd)})}
async function jsonFetch(path,opts={}){const r=await fetch(API+path,{...opts,headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json',...(opts.headers||{})}});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d}
function uploadPart(item,session,partNumber,blob,offset,total){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();state.active.set(item.id,xhr);xhr.open('PUT',`${API}/api/uploads/${encodeURIComponent(session)}/parts/${partNumber}`,true);xhr.setRequestHeader('Authorization',`Bearer ${token()}`);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.upload.onprogress=e=>{if(e.lengthComputable){item.progress=Math.min(100,(offset+e.loaded)/total*100);paint()}};xhr.onload=()=>{state.active.delete(item.id);let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300&&d.part)resolve(d.part);else reject(new Error(d.error||`Part ${partNumber} failed (${xhr.status})`))};xhr.onerror=()=>{state.active.delete(item.id);reject(new Error('Network error while uploading a file chunk'))};xhr.onabort=()=>{state.active.delete(item.id);reject(new Error('Cancelled'))};xhr.send(blob)})}
async function cleanupMultipart(item){if(!item?.uploadSession)return;try{await fetch(`${API}/api/uploads/${encodeURIComponent(item.uploadSession)}`,{method:'DELETE',headers:{Authorization:`Bearer ${token()}`}})}catch{}item.uploadSession=null}
async function largeUpload(item,note){item.status='preparing';item.progress=0;paint();try{const init=await jsonFetch('/api/uploads/init',{method:'POST',body:JSON.stringify({name:item.file.name,mime:item.file.type||'application/octet-stream',size:item.file.size,note})});item.uploadSession=init.id;item.result=init.file||null;const chunk=Number(init.chunk_size||DEFAULT_CHUNK);const parts=[];item.status='uploading';paint();let partNumber=1;for(let offset=0;offset<item.file.size;offset+=chunk,partNumber++){if(state.cancelled)throw new Error('Cancelled');const end=Math.min(item.file.size,offset+chunk),blob=item.file.slice(offset,end);const part=await uploadPart(item,init.id,partNumber,blob,offset,item.file.size);parts.push(part);item.progress=end/item.file.size*100;paint()}item.status='processing';item.progress=100;paint();const done=await jsonFetch(`/api/uploads/${encodeURIComponent(init.id)}/complete`,{method:'POST',body:JSON.stringify({parts})});item.result=done.file||item.result;item.status='done';item.error='';paint();item.uploadSession=null}catch(e){if(String(e.message)==='Cancelled'||state.cancelled){item.status='cancelled';item.error='Cancelled'}else{item.status='error';item.error=e.message||'Large upload failed'}await cleanupMultipart(item);paint()}}
async function uploadOne(item,note){if(item.large)return largeUpload(item,note);return smallUpload(item,note)}
async function worker(note){while(!state.cancelled){const item=state.items.find(i=>i.status==='queued');if(!item)return;await uploadOne(item,note)}}
async function start(){if(state.running)return;const queued=state.items.filter(i=>i.status==='queued');if(!queued.length)return;state.running=true;state.cancelled=false;state.startedAt=Date.now();state.note=$('#buNote').value.trim();$('#buProgressWrap').classList.remove('hidden');render();const currentText=$('#messageInput')?.value?.trim();if(currentText&&currentText===state.note)$('#messageInput').value='';await Promise.all(Array.from({length:Math.min(CONCURRENCY,queued.length)},()=>worker(state.note)));state.running=false;state.active.clear();const failed=state.items.filter(i=>i.status==='error'||i.status==='cancelled').length;$('#buSubtitle').textContent=failed?'Some files need attention. Retry them or close when you are done.':'Your files are stored, understood and filed in Private Office.';render();$('#refreshFeed')?.click();window.PrivateOfficeWorkspace?.refresh?.();if(!failed)toast(`${state.items.filter(i=>i.status==='done').length} file${state.items.filter(i=>i.status==='done').length===1?'':'s'} remembered`)}
function cancelAll(){state.cancelled=true;for(const xhr of state.active.values())try{xhr.abort()}catch{}for(const i of state.items){if(i.status==='queued'){i.status='cancelled';i.error='Cancelled'}if(i.uploadSession)cleanupMultipart(i)}render()}
function install(){const input=$('#fileInput');if(!input)return;input.multiple=true;input.setAttribute('multiple','');input.onchange=e=>{const files=e.target.files;open(files);e.target.value=''}}
function boot(){modal();install();new MutationObserver(()=>{const i=$('#fileInput');if(i&&!i.multiple)install()}).observe(document.documentElement,{subtree:true,childList:true})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
window.PrivateOfficeBatchUpload={open};
})();
