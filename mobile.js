(() => {
'use strict';

function loadMobileCSS(){
  if(document.querySelector('link[data-private-office-mobile]'))return;
  const link=document.createElement('link');
  link.rel='stylesheet';link.href='./mobile.css';link.dataset.privateOfficeMobile='1';
  document.head.appendChild(link);
}

function clickExisting(action){
  const el=[...document.querySelectorAll(`[data-action="${action}"]`)].find(x=>!x.closest('.mobileBottomNav'));
  if(el)el.click();
}

function setActive(name){
  document.querySelectorAll('.mobileNavItem').forEach(b=>b.classList.toggle('active',b.dataset.mobile===name));
}

function injectShell(){
  const app=document.querySelector('#app');
  if(!app||document.querySelector('.mobileTopbar'))return;

  const top=document.createElement('header');
  top.className='mobileTopbar';
  top.innerHTML=`
    <div class="mobileBrand">
      <div class="mobileBrandMark">PO</div>
      <div class="mobileBrandText"><b>Private Office</b><small id="mobileStatus">Everything, remembered.</small></div>
    </div>
    <div class="mobileTopActions">
      <button class="mobileIconBtn" id="mobileOrganize" aria-label="Organize Drive" title="Organize Drive">↻</button>
      <img class="mobileAvatar" id="mobileAvatar" alt="Profile">
    </div>`;

  const nav=document.createElement('nav');
  nav.className='mobileBottomNav';
  nav.setAttribute('aria-label','Private Office');
  nav.innerHTML=`
    <button class="mobileNavItem active" data-mobile="home"><span class="mi">⌂</span><span>Home</span></button>
    <button class="mobileNavItem" data-mobile="ask"><span class="mi">✦</span><span>Ask</span></button>
    <button class="mobileNavItem add" data-mobile="add" aria-label="Add anything"><span class="mi">＋</span><span>Add</span></button>
    <button class="mobileNavItem" data-mobile="library"><span class="mi">▤</span><span>Library</span></button>
    <button class="mobileNavItem" data-mobile="vault"><span class="mi">◇</span><span>Vault</span></button>`;

  app.prepend(top);app.append(nav);

  nav.addEventListener('click',e=>{
    const b=e.target.closest('.mobileNavItem');if(!b)return;
    const name=b.dataset.mobile;
    if(name==='home'){window.scrollTo({top:0,behavior:'smooth'});setActive('home');}
    if(name==='ask'){document.querySelector('#chatCard')?.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>document.querySelector('#prompt')?.focus(),350);setActive('ask');}
    if(name==='add'){clickExisting('upload');setActive('add');}
    if(name==='library'){clickExisting('library');setActive('library');}
    if(name==='vault'){clickExisting('vault');setActive('vault');}
  });

  document.querySelector('#mobileOrganize').onclick=()=>clickExisting('sync');

  const mirror=()=>{
    const srcAvatar=document.querySelector('#avatar');
    const dstAvatar=document.querySelector('#mobileAvatar');
    if(srcAvatar&&dstAvatar&&srcAvatar.src)dstAvatar.src=srcAvatar.src;
    const status=document.querySelector('#syncState')?.textContent||'Everything, remembered.';
    const ms=document.querySelector('#mobileStatus');if(ms)ms.textContent=status;
  };
  mirror();
  const targets=[document.querySelector('#avatar'),document.querySelector('#syncState'),document.querySelector('#userName')].filter(Boolean);
  targets.forEach(t=>new MutationObserver(mirror).observe(t,{attributes:true,childList:true,subtree:true,characterData:true}));

  document.querySelectorAll('.overlay').forEach(o=>new MutationObserver(()=>{
    if(!o.classList.contains('hidden'))return;
    if(!document.querySelector('.overlay:not(.hidden)'))setActive('home');
  }).observe(o,{attributes:true,attributeFilter:['class']}));

  window.addEventListener('scroll',()=>{
    if(document.querySelector('.overlay:not(.hidden)'))return;
    const chat=document.querySelector('#chatCard');
    if(!chat)return;
    const r=chat.getBoundingClientRect();
    setActive(r.top<window.innerHeight*.42&&r.bottom>140?'ask':'home');
  },{passive:true});
}

function improveMobileMeta(){
  const viewport=document.querySelector('meta[name="viewport"]');
  if(viewport)viewport.setAttribute('content','width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content');
  if(!document.querySelector('meta[name="apple-mobile-web-app-capable"]')){
    const capable=document.createElement('meta');capable.name='apple-mobile-web-app-capable';capable.content='yes';document.head.appendChild(capable);
    const status=document.createElement('meta');status.name='apple-mobile-web-app-status-bar-style';status.content='default';document.head.appendChild(status);
  }
}

loadMobileCSS();improveMobileMeta();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',injectShell);else injectShell();
})();
