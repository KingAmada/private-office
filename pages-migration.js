(() => {
'use strict';
const API=String(window.PRIVATE_OFFICE_CONFIG?.API_URL||'').replace(/\/$/,'');
const SESSION_KEY='private_office_session_v1';
const OLD_APP='https://kingamada.github.io/private-office/';
const NEW_APP='https://private-office.pages.dev/';
const $=s=>document.querySelector(s);
const token=()=>localStorage.getItem(SESSION_KEY)||'';

async function api(path,opts={}){
  const headers={...(opts.headers||{})};
  if(token())headers.Authorization=`Bearer ${token()}`;
  const r=await fetch(API+path,{...opts,headers});let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d;
}
function addOwnerLinkButton(){
  if($('#linkExistingOwner'))return;
  const card=$('.accessCard');if(!card)return;
  const b=document.createElement('button');b.id='linkExistingOwner';b.className='primary full';b.style.marginTop='14px';b.textContent='Link existing Owner access';
  b.onclick=()=>{location.href=OLD_APP+'?link-pages=1'};
  const err=$('#accessError');card.insertBefore(b,err||null);
}
async function configureAccess(){
  if(new URLSearchParams(location.search).get('invite'))return;
  if(token())return;
  try{
    const d=await api('/api/health');
    if(!d.owner_exists)return;
    $('#ownerSetupToggle')?.classList.add('hidden');
    $('#ownerSetup')?.classList.add('hidden');
    const p=$('#accessText');if(p)p.textContent='This Private Office already has an Owner. Link this browser to your existing Owner access, or open a private invitation link.';
    if(location.hostname==='private-office.pages.dev')addOwnerLinkButton();
  }catch{}
}
async function migrateFromOldOrigin(){
  const params=new URLSearchParams(location.search);
  if(params.get('link-pages')!=='1'||location.hostname!=='kingamada.github.io')return;
  const session=token();
  if(!session){
    history.replaceState({},'',location.pathname);
    const p=$('#accessText');if(p)p.textContent='Your old Owner session is not available on this browser. Open Private Office on a device where you are already signed in and use Me → Link another device.';
    return;
  }
  try{
    const d=await api('/api/owner/device-link',{method:'POST'});
    location.replace(d.invite.url);
  }catch(e){
    history.replaceState({},'',location.pathname);
    const err=$('#accessError');if(err){err.textContent=e.message;err.classList.remove('hidden')}
  }
}
function injectDeviceLink(){
  const role=String($('#profileRole')?.textContent||'').trim().toLowerCase();
  const body=$('#profileModal .sheetBody');if(role!=='owner'||!body||$('#ownerDeviceLink'))return;
  const b=document.createElement('button');b.id='ownerDeviceLink';b.className='primary full';b.style.marginBottom='10px';b.textContent='Link another device';
  b.onclick=async()=>{
    const old=b.textContent;b.textContent='Creating secure link…';b.disabled=true;
    try{
      const d=await api('/api/owner/device-link',{method:'POST'});
      try{await navigator.clipboard.writeText(d.invite.url);b.textContent='Link copied — valid 15 min'}catch{prompt('Open this one-time Owner link on the other device:',d.invite.url);b.textContent='Link created'}
    }catch(e){b.textContent=e.message}
    setTimeout(()=>{if(b.isConnected){b.textContent=old;b.disabled=false}},3500);
  };
  body.insertBefore(b,$('#logoutButton')||body.firstChild);
}
function ready(){configureAccess();migrateFromOldOrigin();injectDeviceLink();new MutationObserver(injectDeviceLink).observe(document.documentElement,{subtree:true,childList:true,characterData:true})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
