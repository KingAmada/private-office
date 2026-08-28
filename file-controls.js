(() => {
'use strict';
const API = String(window.PRIVATE_OFFICE_CONFIG?.API_URL || '').replace(/\/$/, '');
const SESSION_KEY = 'private_office_session_v1';
const $ = s => document.querySelector(s);

function owner(){ return String($('#profileRole')?.textContent || '').trim().toLowerCase() === 'owner'; }
function toast(text){ const t=$('#toast'); if(!t)return; t.textContent=text; t.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.remove('show'),3200); }

async function remove(fileId, button){
  const card = button.closest('.fileCard,.listItem');
  const name = card?.querySelector('b')?.textContent?.trim() || 'this file';
  if(!confirm(`Delete “${name}” permanently from Private Office?\n\nThis removes the original file from storage.`)) return;
  const old=button.textContent; button.textContent='Deleting…'; button.disabled=true;
  try{
    const token=localStorage.getItem(SESSION_KEY)||'';
    const r=await fetch(`${API}/api/files/${encodeURIComponent(fileId)}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});
    let d={}; try{d=await r.json()}catch{}
    if(!r.ok) throw new Error(d.error||'Could not delete file');
    toast('File deleted');
    $('#refreshFeed')?.click();
    const search=$('#librarySearch');
    if(search && !$('#libraryModal')?.classList.contains('hidden')) search.dispatchEvent(new Event('input',{bubbles:true}));
  }catch(e){ toast(e.message); button.textContent=old; button.disabled=false; }
}

function enhance(){
  if(!owner()) return;
  document.querySelectorAll('.fileActions').forEach(actions=>{
    if(actions.querySelector('.deleteFile')) return;
    const source=actions.querySelector('.openFile,.retryFile');
    const id=source?.dataset.fileId;
    if(!id) return;
    const b=document.createElement('button');
    b.className='deleteFile'; b.dataset.fileId=id; b.textContent='Delete';
    b.style.color='#9d2c2c';
    b.onclick=()=>remove(id,b);
    actions.prepend(b);
  });
}

new MutationObserver(enhance).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
setInterval(enhance,1200);
enhance();
})();
