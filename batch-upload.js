(() => {
'use strict';
const C=window.PRIVATE_OFFICE_CONFIG||{};
const API=String(C.API_URL||'').replace(/\/$/,'');
const SESSION_KEY='private_office_session_v1';
const MAX_BYTES=(Number(C.MAX_UPLOAD_MB)||12)*1048576;
const CONCURRENCY=2;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmt=n=>{n=Number(n||0);if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`};
const uid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
const state={items:[],running:false,cancelled:false,active:new Map(),note:'',startedAt:0};
function token(){return localStorage.getItem(SESSION_KEY)||''}
function toast(t){const x=$('#toast');if(!x)return;x.textContent=t;x.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>x.classList.remove('show'),3300)}
function stageLabel(i){return i.status==='queued'?'Waiting':i.status==='uploading'?`Uploading ${Math.round(i.progress)}%`:i.status==='processing'?'AI reading & filing…':i.status==='done'?'Remembered':i.status==='error'?'Needs attention':i.status==='cancelled'?'Cancelled':'Waiting'}
function statusClass(i){return `bu-${i.status}`}
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
      <label id="buDrop" class="buDrop"><input id="buMore" type="file" multiple hidden><span class="buDropIcon">＋</span><div><b>Add files</b><small>Choose several at once or drop them here · max ${Number(C.MAX_UPLOAD_MB)||12} MB each</small></div></label>
      <label class="buNote"><span>Context for these files <em>optional</em></span><textarea id="buNote" rows="2" placeholder="e.g. These are the latest documents from ABC Holdings"></textarea></label>
      <div class="buQueueHead"><b id="buCount">0 files</b><button id="buClear" type="button">Clear all</button></div>
      <div id="buList" class="buList"></div>
    </div>
    <footer class="buFoot"><button id="buCancel" class="buButton buSecondary">Cancel</button><button id="buStart" class="buButton buPrimary">Upload files</button><button id="buFiles" class="buButton buPrimary hidden">Open Files</button></footer>
  </section>`;document.body.appendChild(m);bindModal();return m}
function bindModal(){
  $('#buClose').onclick=()=>close();$('#buCancel').onclick=()=>state.running?cancelAll():close();$('#buStart').onclick=start;$('#buFiles').onclick=()=>{close(true);document.querySelector('[data-nav="memory"]')?.click()};$('#buClear').onclick=()=>{if(!state.running){state.items=[];render()}};
  $('#buMore').onchange=e=>{addFiles(e.target.files);e.target.value=''};const drop=$('#buDrop');['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();if(!state.running)drop.classList.add('drag')}));['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag')}));drop.addEventListener('drop',e=>{if(!state.running)addFiles(e.dataTransfer.files)});
  $('#buList').onclick=e=>{const remove=e.target.closest('[data-remove]');if(remove&&!state.running){state.items=state.items.filter(x=>x.id!==remove.dataset.remove);render();return}const retry=e.target.closest('[data-retry]');if(retry&&!state.running){const item=state.items.find(x=>x.id===retry.dataset.retry);if(item){item.status='queued';item.error='';item.progress=0;render()}}};
}
function open(files){modal();const text=$('#messageInput')?.value?.trim()||'';$('#buNote').value=text;$('#batchUploadModal').classList.remove('hidden');document.body.classList.add('buOpen');addFiles(files);}
function close(force=false){if(state.running&&!force)return;$('#batchUploadModal')?.classList.add('hidden');document.body.classList.remove('buOpen');if(!state.running){state.items=[];state.cancelled=false;render()}}
function addFiles(fileList){const files=[...(fileList||[])];if(!files.length)return;for(const file of files){const key=`${file.name}|${file.size}|${file.lastModified}`;if(state.items.some(x=>x.key===key))continue;state.items.push({id:uid(),key,file,name:file.name,size:file.size,status:file.size>MAX_BYTES?'error':'queued',error:file.size>MAX_BYTES?`Larger than ${Number(C.MAX_UPLOAD_MB)||12} MB`:'',progress:0,result:null})}render()}
function render(){if(!$('#batchUploadModal'))return;const list=$('#buList'),n=state.items.length;$('#buCount').textContent=`${n} file${n===1?'':'s'}`;$('#buClear').classList.toggle('hidden',!n||state.running);$('#buStart').disabled=state.running||!state.items.some(i=>i.status==='queued');$('#buStart').textContent=n===1?'Upload & remember':'Upload & remember all';$('#buDrop').classList.toggle('disabled',state.running);$('#buNote').disabled=state.running;$('#buMore').disabled=state.running;list.innerHTML=n?state.items.map(i=>`<article class="buRow ${statusClass(i)}">
    <div class="buFileIcon">${esc((i.name.split('.').pop()||'FILE').slice(0,4).toUpperCase())}</div>
    <div class="buFileMain"><div class="buFileTop"><b title="${esc(i.name)}">${esc(i.result?.name||i.name)}</b><span>${fmt(i.size)}</span></div><small>${esc(i.error||stageLabel(i))}</small><div class="buBar"><i style="width:${barPercent(i)}%"></i></div>${i.result?.category?`<em>${esc([i.result.category,i.result.entity_name,i.result.document_type].filter(Boolean).join(' → '))}</em>`:''}</div>
    <div class="buRowAction">${i.status==='error'&&!state.running?`<button data-retry="${i.id}">Retry</button>`:!state.running?`<button data-remove="${i.id}" aria-label="Remove">×</button>`:i.status==='done'?'<span>✓</span>':i.status==='processing'?'<span class="buSpin">◌</span>':''}</div>
  </article>`).join(''):`<div class="buEmpty"><span>⇧</span><b>No files selected yet</b><small>Add documents, photos, spreadsheets, PDFs and more.</small></div>`;updateOverall()}
function barPercent(i){if(i.status==='done')return 100;if(i.status==='processing')return Math.max(92,i.progress);if(i.status==='error'||i.status==='cancelled')return i.progress||0;return Math.min(90,i.progress*.9)}
function updateOverall(){if(!$('#batchUploadModal'))return;const n=state.items.length,done=state.items.filter(i=>i.status==='done').length,failed=state.items.filter(i=>i.status==='error').length,active=state.items.filter(i=>i.status==='uploading'||i.status==='processing').length;const value=n?Math.round(state.items.reduce((sum,i)=>sum+barPercent(i),0)/n):0;$('#buOverallBar').style.width=`${value}%`;$('#buPercent').textContent=`${value}%`;$('#buProgressText').textContent=`${done} of ${n} remembered${failed?` · ${failed} failed`:''}`;$('#buProgressTitle').textContent=state.running?(active?'Uploading and organizing':'Finishing…'):(done===n&&n?'Everything remembered':failed?'Upload finished with issues':'Ready');}
function uploadOne(item,note){return new Promise(resolve=>{const xhr=new XMLHttpRequest();state.active.set(item.id,xhr);item.status='uploading';item.progress=0;render();const fd=new FormData();fd.append('text',note);fd.append('file',item.file,item.file.name);xhr.open('POST',`${API}/api/message`,true);xhr.setRequestHeader('Authorization',`Bearer ${token()}`);xhr.upload.onprogress=e=>{if(e.lengthComputable){item.progress=Math.min(100,e.loaded/e.total*100);paintItem(item)}};xhr.upload.onload=()=>{if(item.status==='uploading'){item.status='processing';item.progress=100;paintItem(item)}};xhr.onload=()=>{state.active.delete(item.id);let d={};try{d=JSON.parse(xhr.responseText||'{}')}catch{}if(xhr.status>=200&&xhr.status<300){item.status='done';item.progress=100;item.result=d.file||null;item.error=''}else{item.status='error';item.error=d.error||`Upload failed (${xhr.status})`}paintItem(item);resolve()};xhr.onerror=()=>{state.active.delete(item.id);item.status='error';item.error='Network error — try again';paintItem(item);resolve()};xhr.onabort=()=>{state.active.delete(item.id);item.status='cancelled';item.error='Cancelled';paintItem(item);resolve()};xhr.send(fd)})}
function paintItem(item){const row=[...document.querySelectorAll('.buRow')].find(r=>r.querySelector(`[data-remove="${item.id}"]`)||r.querySelector(`[data-retry="${item.id}"]`));render()}
async function worker(note){while(!state.cancelled){const item=state.items.find(i=>i.status==='queued');if(!item)return;await uploadOne(item,note)}}
async function start(){if(state.running)return;const queued=state.items.filter(i=>i.status==='queued');if(!queued.length)return;state.running=true;state.cancelled=false;state.startedAt=Date.now();state.note=$('#buNote').value.trim();$('#buProgressWrap').classList.remove('hidden');$('#buStart').classList.add('hidden');$('#buCancel').textContent='Cancel uploads';render();const currentText=$('#messageInput')?.value?.trim();if(currentText&&currentText===state.note)$('#messageInput').value='';await Promise.all(Array.from({length:Math.min(CONCURRENCY,queued.length)},()=>worker(state.note)));state.running=false;state.active.clear();$('#buCancel').textContent='Close';$('#buStart').classList.add('hidden');$('#buFiles').classList.remove('hidden');const failed=state.items.filter(i=>i.status==='error'||i.status==='cancelled').length;$('#buProgressTitle').textContent=failed?'Upload finished':'Everything remembered';$('#buSubtitle').textContent=failed?'Some files need attention. You can retry them before closing.':'Your files are stored, understood and filed in Private Office.';render();$('#refreshFeed')?.click();window.PrivateOfficeWorkspace?.refresh?.();if(!failed)toast(`${state.items.length} file${state.items.length===1?'':'s'} remembered`)}
function cancelAll(){state.cancelled=true;for(const xhr of state.active.values())try{xhr.abort()}catch{}for(const i of state.items)if(i.status==='queued')i.status='cancelled';render()}
function install(){const input=$('#fileInput');if(!input)return;input.multiple=true;input.setAttribute('multiple','');input.onchange=e=>{const files=e.target.files;open(files);e.target.value=''};}
function boot(){modal();install();new MutationObserver(()=>{const i=$('#fileInput');if(i&&!i.multiple)install()}).observe(document.documentElement,{subtree:true,childList:true});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
window.PrivateOfficeBatchUpload={open};
})();