(() => {
'use strict';
const API=String(window.PRIVATE_OFFICE_CONFIG?.API_URL||'').replace(/\/$/,'');
const SESSION_KEY='private_office_session_v1';
const nativeFetch=window.fetch.bind(window);
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[m]));
const token=()=>localStorage.getItem(SESSION_KEY)||'';

window.fetch=async function(input,init){
  const res=await nativeFetch(input,init);
  try{
    const url=typeof input==='string'?input:input?.url||'';
    if(url.includes('/api/message')&&(res.headers.get('content-type')||'').includes('application/json')){
      res.clone().json().then(d=>{
        if(d?.vault_reveal)window.dispatchEvent(new CustomEvent('private-office-vault-reveal',{detail:d.vault_reveal}));
        if(d?.vault_config_required)window.dispatchEvent(new CustomEvent('private-office-vault-config'));
      }).catch(()=>{});
    }
  }catch{}
  return res;
};

async function api(path,opts={}){
  const h={...(opts.headers||{}),Authorization:`Bearer ${token()}`};
  const r=await nativeFetch(API+path,{...opts,headers:h});let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d;
}

function ensureModal(){
  let o=$('#vaultOverlay');if(o)return o;
  o=document.createElement('div');o.id='vaultOverlay';o.className='vaultOverlay hidden';o.innerHTML=`<section class="vaultPanel"><header class="vaultHead"><div><span class="eyebrow">OWNER ONLY</span><h3>Private Vault</h3><p>Passwords are encrypted separately from normal office memory.</p></div><button class="vaultClose" aria-label="Close">×</button></header><div id="vaultBody" class="vaultBody"></div></section>`;document.body.appendChild(o);o.querySelector('.vaultClose').onclick=()=>closeVault();o.onclick=e=>{if(e.target===o)closeVault()};return o;
}
function closeVault(){const o=$('#vaultOverlay');if(o)o.classList.add('hidden')}
function openShell(){ensureModal().classList.remove('hidden')}

function injectLaunch(){
  const body=$('#profileModal .sheetBody');if(!body||$('#openPrivateVault'))return;
  const role=String($('#profileRole')?.textContent||'').trim().toLowerCase();if(role!=='owner')return;
  const b=document.createElement('button');b.id='openPrivateVault';b.className='vaultLaunch';b.innerHTML=`<span class="vaultLaunchIcon">◇</span><div><b>Private Vault</b><small>Owner-only encrypted passwords</small></div>`;b.onclick=()=>{document.querySelector('[data-close="profileModal"]')?.click();openVault()};body.insertBefore(b,$('#logoutButton')||body.firstChild);
}

async function openVault(){
  openShell();const body=$('#vaultBody');body.innerHTML='<div class="vaultEmpty">Opening encrypted vault…</div>';
  try{
    const d=await api('/api/vault');
    if(!d.configured){body.innerHTML=`<div class="vaultConfig"><b>Vault encryption is not configured yet.</b><br>Add a Cloudflare Worker secret named <code>VAULT_MASTER_KEY</code> with at least 32 random characters, deploy it, then reopen Private Vault.</div>`;return}
    const items=d.items||[];
    body.innerHTML=`<div class="vaultNotice">Secrets are never sent to OpenAI and never stored in normal chat messages. Reveal actions are owner-only and audited.</div>`+(items.length?items.map(x=>`<div class="vaultItem" data-id="${esc(x.id)}"><div><b>${esc(x.label)}</b><small>Updated ${new Date(x.updated_at).toLocaleString()}</small></div><div class="vaultActions"><button data-reveal="${esc(x.id)}">Reveal</button><button class="vaultDelete" data-delete="${esc(x.id)}">Delete</button></div></div>`).join(''):'<div class="vaultEmpty">No passwords saved yet.<br>Tell Private Office: “My password for … is …”</div>');
    body.querySelectorAll('[data-reveal]').forEach(b=>b.onclick=()=>revealById(b.dataset.reveal));
    body.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>deleteById(b));
  }catch(e){body.innerHTML=`<div class="vaultConfig">${esc(e.message)}</div>`}
}

async function revealById(id){try{const d=await api(`/api/vault/${encodeURIComponent(id)}/reveal`,{method:'POST'});showReveal(d)}catch(e){const body=$('#vaultBody');body.innerHTML=`<div class="vaultConfig">${esc(e.message)}</div>`}}
async function deleteById(button){
  if(button.dataset.confirm!=='1'){button.dataset.confirm='1';button.textContent='Confirm delete';setTimeout(()=>{if(button.isConnected){button.dataset.confirm='';button.textContent='Delete'}},3500);return}
  button.disabled=true;try{await api(`/api/vault/${encodeURIComponent(button.dataset.delete)}`,{method:'DELETE'});await openVault()}catch(e){button.disabled=false;button.textContent=e.message}
}

function showReveal(item){
  if(!item?.secret)return;openShell();const body=$('#vaultBody');let visible=false,timer=null;const secret=String(item.secret),label=String(item.label||'Password');
  body.innerHTML=`<div class="vaultReveal"><div class="vaultRevealTop"><div class="lock">◇</div><h3>${esc(label)}</h3><p>Private Vault · owner-only reveal</p></div><div id="vaultSecretBox" class="vaultSecretBox">••••••••••••</div><div class="vaultRevealButtons"><button id="vaultToggle">Reveal password</button><button id="vaultCopy" class="primary">Copy password</button></div><div id="vaultTimer" class="vaultTimer">Hidden until you reveal it.</div></div>`;
  const box=$('#vaultSecretBox'),toggle=$('#vaultToggle'),note=$('#vaultTimer');
  const hide=()=>{visible=false;box.textContent='••••••••••••';toggle.textContent='Reveal password';note.textContent='Hidden.';if(timer){clearTimeout(timer);timer=null}};
  const reveal=()=>{visible=true;box.textContent=secret;toggle.textContent='Hide password';note.textContent='Automatically hides again in 20 seconds.';if(timer)clearTimeout(timer);timer=setTimeout(hide,20000)};
  toggle.onclick=()=>visible?hide():reveal();
  $('#vaultCopy').onclick=async()=>{try{await navigator.clipboard.writeText(secret);note.textContent='Copied to clipboard. The value remains hidden here.'}catch{reveal();note.textContent='Copy was blocked by the browser; password is revealed above.'}};
}

window.addEventListener('private-office-vault-reveal',e=>setTimeout(()=>showReveal(e.detail),150));
window.addEventListener('private-office-vault-config',()=>setTimeout(()=>openVault(),200));
new MutationObserver(injectLaunch).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{ensureModal();injectLaunch()});else{ensureModal();injectLaunch()}
window.PrivateOfficeVault={open:openVault,showReveal};
})();
