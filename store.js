// ════════════════════════════════════
// ⚙️  SETTINGS
// ════════════════════════════════════

// صور البانر

// ملاحظة: WHATSAPP_VIP, CONTACT_TELEGRAM, CONTACT_WHATSAPP_NUMBER, STORE_LOGO_URL, STORE_NAME, AMR_DEV_URL
// جميعها معرّفة في config.js — لا تُعرّفها هنا مجدداً

// مستويات VIP
const VIP_LEVELS = [
  { level:0, name:"VIP 0", discount:0, desc:"المستوى الافتراضي لجميع الحسابات" },
  { level:1, name:"VIP 1", discount:3, desc:"خصم 3% على جميع المنتجات" },
  { level:2, name:"VIP 2", discount:5, desc:"خصم 5% على جميع المنتجات" },
];

// مدة المزامنة التلقائية (ميلي ثانية) — 30 ثانية (رصيد + VIP فقط)
const SYNC_INTERVAL = 30000;

// ════════════════════════════════════
// STATE
// ════════════════════════════════════
let currentUser=null, products=[], orders=[], deposits=[], categoriesData=[],paymentMethods=[],storeBanners=[];
let navStack=[], currentParentId=null, pendingProduct=null;
let depMethod=null, depCurrency=null, purchaseInProgress=false, depositInProgress=false;
let slideIdx=0, syncTimer=null,bannerTimer=null,storeRealtimeChannel=null,storeRealtimeTimer=null;
let storeLoadPromise=null,storeLoadQueued=false;
let missingStoreSettingsWarningShown=false;
let defaultCurrency = localStorage.getItem('nx_currency')||'SYP';

// ════════════════════════════════════
// HELPERS
// ════════════════════════════════════
function showToast(msg,type='info'){
  const t=document.getElementById("toast");
  t.textContent=msg;
  const c={error:'rgba(239,68,68,0.4)',success:'rgba(34,197,94,0.4)',info:'rgba(59,130,246,0.3)'};
  t.style.borderColor=c[type]||c.info; t.style.opacity="1"; clearTimeout(t._t);
  t._t=setTimeout(()=>t.style.opacity="0",3000);
}
const showLoading=()=>document.getElementById("loadingOverlay").classList.add("show");
const hideLoading=()=>document.getElementById("loadingOverlay").classList.remove("show");
const closeModal=id=>document.getElementById(id).classList.remove("open");
const openModal=id=>document.getElementById(id).classList.add("open");

function isMissingStoreSettingsTable(error,table){
  const description=[error?.message,error?.details,error?.hint].filter(Boolean).join(" ").toLowerCase();
  return description.includes(table)&&(
    error?.code==="PGRST205"||
    (error?.status===404&&description.includes("schema cache"))
  );
}

async function notifyTelegram(kind,id){
  try{
    const {error}=await sbClient.functions.invoke("notify-telegram",{body:{kind,id}});
    if(error)throw error;
    return true;
  }catch(e){console.error("Telegram notification failed:",e);return false;}
}

async function loadProfile(userId){
  const {data,error}=await sbClient.from("profiles")
    .select("id,username,phone,balance_syp,balance_usd,vip_level,created_at")
    .eq("id",userId).single();
  if(error) throw error;
  return data;
}

async function signedReceipt(path){
  if(!path)return "";
  const {data,error}=await sbClient.storage.from("transfer-receipts").createSignedUrl(path,3600);
  if(error)throw error;
  return data.signedUrl;
}

// ════════════════════════════════════
// VIP
// ════════════════════════════════════
const getVipLevel=u=>Number(u?.vip_level||0);
const getVipDisc=lv=>(VIP_LEVELS.find(v=>v.level===lv)||VIP_LEVELS[0]).discount;
const applyDisc=(price,lv)=>{ const d=getVipDisc(lv); return d?Math.floor(price*(1-d/100)):price; };
function vipBadgeHTML(lv){
  const v=VIP_LEVELS.find(x=>x.level===lv)||VIP_LEVELS[0];
  const s=lv===0?'○':lv===1?'★':'★★';
  return `<span class="vip-badge vip-${Math.min(lv,3)}" onclick="openModal('vipModal')">${s} ${v.name}</span>`;
}
function openWhatsapp(){
  const msg=encodeURIComponent(`مرحبا، أريد الترقية إلى VIP في متجر ${STORE_NAME}. اسم المستخدم: ${currentUser?.username||""}`);
  window.open(`https://wa.me/${WHATSAPP_VIP}?text=${msg}`,"_blank");
}

// ════════════════════════════════════
// SESSION
// ════════════════════════════════════

// ════════════════════════════════════
// AUTO-SYNC — طلب واحد فقط لبيانات المستخدم
// يكتشف التغيير تلقائياً ويحدّث الواجهة
// ════════════════════════════════════
// ════════════════════════════════════
// NOTIFICATION SYSTEM
// ════════════════════════════════════
let notifications = [];
let seenOrderStatuses = {}; // {orderId: status} — to detect changes

function loadNotifState(){
  try{
    const raw = localStorage.getItem('nx_notifs');
    if(raw) notifications = JSON.parse(raw);
    const raw2 = localStorage.getItem('nx_seen_orders');
    if(raw2) seenOrderStatuses = JSON.parse(raw2);
  }catch(e){}
}
function saveNotifState(){
  try{
    localStorage.setItem('nx_notifs', JSON.stringify(notifications.slice(0,50)));
    localStorage.setItem('nx_seen_orders', JSON.stringify(seenOrderStatuses));
  }catch(e){}
}

function pushNotification(icon, title, sub, type='info'){
  const n = { id: 'n_'+Date.now(), icon, title, sub, type, time: Date.now(), read: false };
  notifications.unshift(n);
  saveNotifState();
  renderNotifPanel();
  updateNotifBadge();
  showInAppNotif(icon, title, sub);
  // Browser notification if permitted
  if(Notification.permission === 'granted'){
    try{ new Notification(title, { body: sub, icon: '/favicon.ico' }); }catch(e){}
  }
}

function showInAppNotif(icon, title, sub){
  const el = document.getElementById('inappNotif');
  document.getElementById('inappIcon').textContent = icon;
  document.getElementById('inappTitle').textContent = title;
  document.getElementById('inappSub').textContent = sub;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(()=>el.classList.remove('show'), 5000);
}

function updateNotifBadge(){
  const unread = notifications.filter(n=>!n.read).length;
  const badge = document.getElementById('notifBadge');
  if(badge){
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.classList.toggle('show', unread > 0);
  }
}

function renderNotifPanel(){
  const list = document.getElementById('notifList');
  if(!list) return;
  if(!notifications.length){
    list.innerHTML = '<div class="notif-empty">لا توجد إشعارات</div>';
    return;
  }
  list.innerHTML = notifications.map(n=>{
    const ago = formatAgo(n.time);
    return `<div class="notif-item ${n.read?'':'unread'}" onclick="markNotifRead('${n.id}')">
      <div class="notif-dot"></div>
      <div class="notif-icon">${n.icon}</div>
      <div class="notif-body">
        <div class="notif-title">${n.title}</div>
        <div class="notif-sub">${n.sub}</div>
        <div class="notif-time">${ago}</div>
      </div>
    </div>`;
  }).join('');
}

function formatAgo(ts){
  const diff = Date.now() - ts;
  if(diff < 60000) return 'الآن';
  if(diff < 3600000) return Math.floor(diff/60000) + ' دقيقة';
  if(diff < 86400000) return Math.floor(diff/3600000) + ' ساعة';
  return new Date(ts).toLocaleDateString('ar-EG');
}

function markNotifRead(id){
  const n = notifications.find(x=>x.id===id);
  if(n) n.read = true;
  saveNotifState();
  renderNotifPanel();
  updateNotifBadge();
}

function clearAllNotifs(){
  notifications = [];
  saveNotifState();
  renderNotifPanel();
  updateNotifBadge();
}

function requestNotifPermission(){
  if('Notification' in window && Notification.permission === 'default'){
    Notification.requestPermission();
  }
}

// ════════════════════════════════════
// SYNC USER + ORDERS
// ════════════════════════════════════
async function syncUser(){
  if(!currentUser) return;
  try{
    const oldSYP=Number(currentUser.balance_syp||0),oldUSD=Number(currentUser.balance_usd||0);
    const oldVip=Number(currentUser.vip_level||0);
    currentUser=await loadProfile(currentUser.id);
    const newSYP=Number(currentUser.balance_syp||0),newUSD=Number(currentUser.balance_usd||0);
    const balChanged=newSYP!==oldSYP||newUSD!==oldUSD;
    const vipChanged=Number(currentUser.vip_level||0)!==oldVip;
    if(balChanged || vipChanged){
      updateUI();
      if(currentParentId) renderProds(currentParentId);
      if(balChanged){
        if(newSYP>oldSYP||newUSD>oldUSD){
          pushNotification('💰','تم إضافة رصيد!',`رصيدك: ${newSYP.toLocaleString()} ل.س | $${newUSD.toFixed(2)}`,'success');
        }
      }
    }

    syncUser._cycle = (syncUser._cycle||0)+1;
    if(syncUser._cycle % 2 === 0){
      await checkOrderNotifications();
    }
  }catch(e){ console.warn("sync:",e); }
}

async function checkOrderNotifications(){
  if(!currentUser) return;
  try{
    const {data:freshOrders,error}=await sbClient.from("orders")
      .select("*")
      .eq("user_id",currentUser.id).order("created_at",{ascending:false});
    if(error)throw error;
    let changed = false;
    freshOrders.forEach(o=>{
      const prev = seenOrderStatuses[o.id];
      if(prev !== undefined && prev !== o.status){
        const icons = {completed:'✅', cancelled:'❌', processing:'🔄', pending:'⏳'};
        const labels = {completed:'تم تنفيذ طلبك!', cancelled:'تم رفض طلبك', processing:'طلبك قيد التنفيذ', pending:'طلبك معلق'};
        pushNotification(
          icons[o.status]||'📦',
          labels[o.status]||'تحديث الطلب',
          o.product_name + (o.status==='completed'?' — اكتمل بنجاح':o.status==='cancelled'?' — تم الرفض':''),
          o.status==='completed'?'success':o.status==='cancelled'?'error':'info'
        );
        changed = true;
      }
      seenOrderStatuses[o.id] = o.status;
    });
    orders=freshOrders;
    if(changed){
      saveNotifState();
      renderOrdersHist();
    }
  }catch(e){console.warn("Order status sync failed:",e);}
}

function startSync(){ stopSync(); if(currentUser){ requestNotifPermission(); syncTimer=setInterval(syncUser,SYNC_INTERVAL); } }
function stopSync(){ clearInterval(syncTimer); syncTimer=null; }

function startStoreRealtime(){
  if(storeRealtimeChannel){sbClient.removeChannel(storeRealtimeChannel);storeRealtimeChannel=null;}
  let channel=sbClient.channel("store-live-updates");
  const refreshCatalog=()=>{
    clearTimeout(storeRealtimeTimer);
    storeRealtimeTimer=setTimeout(()=>loadAllData(),180);
  };
  for(const table of ["categories","products","mosaic_layouts","payment_methods","store_banners"]){
    channel=channel.on("postgres_changes",{event:"*",schema:"public",table},refreshCatalog);
  }
  if(currentUser){
    const userId=currentUser.id;
    channel=channel.on("postgres_changes",{event:"*",schema:"public",table:"profiles",filter:`id=eq.${userId}`},()=>syncUser());
    channel=channel.on("postgres_changes",{event:"*",schema:"public",table:"orders",filter:`user_id=eq.${userId}`},()=>{
      checkOrderNotifications().then(()=>renderOrdersHist()).catch(error=>console.error("Realtime order refresh failed:",error));
    });
    channel=channel.on("postgres_changes",{event:"*",schema:"public",table:"deposits",filter:`user_id=eq.${userId}`},()=>{
      clearTimeout(storeRealtimeTimer);
      storeRealtimeTimer=setTimeout(async()=>{await loadAllData();renderDepositsHist();},180);
    });
  }
  storeRealtimeChannel=channel.subscribe((status,error)=>{
    if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"){
      console.error("Store realtime connection failed:",error||status);
      showToast("تعذر الاتصال بالتحديث الفوري. تحقق من تشغيل الترحيل وإعداد Supabase.","error");
    }
  });
}

// ════════════════════════════════════
// UI
// ════════════════════════════════════
function updateUI(){
  const lo=document.getElementById("drawerLoggedOut");
  const li=document.getElementById("drawerLoggedIn");
  const bl=document.getElementById("btnLogout");
  if(currentUser){
    lo.style.display="none"; li.style.display="block"; bl.style.display="block";
    const ini=(currentUser.username||"?")[0].toUpperCase();
    document.getElementById("drawerUserAvatar").textContent=ini;
    document.getElementById("drawerUsername").textContent=currentUser.username;
    const sypB=currentUser.balance_syp||0, usdB=currentUser.balance_usd||0;
    document.getElementById("drawerBalance").textContent=`${sypB.toLocaleString()} ل.س | $${usdB.toFixed(2)}`;
    document.getElementById("upcUsername").textContent=currentUser.username.toUpperCase();
    document.getElementById("upcId").textContent="ID: "+currentUser.id;
    document.getElementById("upcPhone").textContent=currentUser.phone?("📱 "+currentUser.phone):"";
    updateCurrencyUI();
    document.getElementById("upcBalSYP").textContent=sypB.toLocaleString()+" ل.س";
    document.getElementById("upcBalUSD").textContent="$"+usdB.toFixed(2)+" USD";
    document.getElementById("upcBalanceBlock").style.display="flex";
    document.getElementById("upcBalGuest").style.display="none";
    const lv=getVipLevel(currentUser);
    document.getElementById("upcVipWrap").innerHTML=vipBadgeHTML(lv);
    const vi=VIP_LEVELS.find(v=>v.level===lv)||VIP_LEVELS[0];
    document.getElementById("vipCurrentLabel").textContent=vi.name+(vi.discount?` — خصم ${vi.discount}%`:" — بدون خصم");
  } else {
    lo.style.display="block"; li.style.display="none"; bl.style.display="none";
    document.getElementById("upcUsername").textContent="USERNAME";
    document.getElementById("upcId").textContent="ID: —";
    document.getElementById("upcBalanceBlock").style.display="none";
    document.getElementById("upcBalGuest").style.display="block";
    document.getElementById("upcVipWrap").innerHTML="";
  }
  renderVipModal();
}

function renderVipModal(){
  const lv=getVipLevel(currentUser);
  document.getElementById("vipLevelsGrid").innerHTML=VIP_LEVELS.map(v=>`
    <div class="vip-lv-card vlc-${v.level}">
      <div>
        <div class="vip-lv-name">${v.level===0?'○':v.level===1?'★':'★★'} ${v.name}</div>
        <div class="vip-lv-desc">${v.desc}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <div class="vip-lv-disc">${v.discount?v.discount+'%':'—'}</div>
        ${lv===v.level?'<span class="vip-cur-tag">مستواك</span>':''}
      </div>
    </div>`).join('');
}

// ════════════════════════════════════
// BANNER SLIDER
// ════════════════════════════════════
function renderBanners(banners){
  const el=document.getElementById("bannerSlider");
  clearInterval(bannerTimer);
  slideIdx=0;
  const activeBanners=(banners||[]).filter(banner=>banner.is_active&&banner.image_url);
  if(!activeBanners.length){el.replaceChildren();el.style.display="none";return;}
  el.style.display="";
  el.replaceChildren();
  activeBanners.forEach((banner,i)=>{
    const s=document.createElement("div"); s.className="banner-slide"+(i===0?" active":"");
    const img=document.createElement("img");img.src=banner.image_url;img.alt=banner.alt_text||"";
    img.onerror=()=>{s.remove();const remaining=el.querySelectorAll(".banner-slide");if(!remaining.length)el.style.display="none";};
    if(banner.href){
      try{
        const url=new URL(banner.href);
        if(["http:","https:"].includes(url.protocol)){
          const link=document.createElement("a");link.href=url.href;link.target="_blank";link.rel="noopener noreferrer";link.appendChild(img);s.appendChild(link);
        }else s.appendChild(img);
      }catch(e){s.appendChild(img);}
    }else s.appendChild(img);
    el.appendChild(s);
  });
  if(activeBanners.length>1){
    const dots=document.createElement("div"); dots.className="slider-dots";
    activeBanners.forEach((_,i)=>{
      const d=document.createElement("div"); d.className="dot"+(i===0?" active":"");
      d.onclick=()=>showSlide(i); dots.appendChild(d);
    });
    el.appendChild(dots);
    bannerTimer=setInterval(()=>showSlide((slideIdx+1)%activeBanners.length),4000);
  }
}
function showSlide(i){
  const slider=document.getElementById("bannerSlider");
  slider.querySelectorAll(".banner-slide").forEach(s=>s.classList.remove("active"));
  slider.querySelectorAll(".dot").forEach(d=>d.classList.remove("active"));
  slider.querySelectorAll(".banner-slide")[i]?.classList.add("active");
  slider.querySelectorAll(".dot")[i]?.classList.add("active");
  slideIdx=i;
}

// ════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════
function renderBreadcrumb(){
  const nav=document.getElementById("breadcrumb");
  if(!navStack.length){ nav.style.display="none"; return; }
  nav.style.display="flex"; nav.innerHTML="";
  const h=document.createElement("span"); h.className="bc-item"; h.textContent="الرئيسية"; h.onclick=goHome; nav.appendChild(h);
  navStack.forEach((item,i)=>{
    const sep=document.createElement("span"); sep.className="bc-sep"; sep.textContent="›"; nav.appendChild(sep);
    if(i<navStack.length-1){ const el=document.createElement("span"); el.className="bc-item"; el.textContent=item.name; el.onclick=()=>jumpTo(item.id,item.name,i); nav.appendChild(el); }
    else { const el=document.createElement("span"); el.className="bc-current"; el.textContent=item.name; nav.appendChild(el); }
  });
}
function goHome(){ currentParentId=null; navStack=[]; renderBreadcrumb(); renderCats(); }
function jumpTo(id,name,idx){ navStack=navStack.slice(0,idx+1); currentParentId=id; renderBreadcrumb(); renderCats(); }
function openCat(cat){
  navStack.push({id:cat.id,name:cat.name}); currentParentId=cat.id; renderBreadcrumb();
  categoriesData.filter(c=>(c.parentId||null)===cat.id).length ? renderCats() : renderProds(cat.id);
}
const getCatName=id=>{ const c=categoriesData.find(x=>x.id===id); return c?c.name:""; };
function safeImageCss(value){
  if(!value)return "";
  try{
    const url=new URL(value,window.location.href);
    if(!["https:","http:"].includes(url.protocol))return "";
    const safeUrl=url.href.replace(/["\\\r\n]/g,character=>encodeURIComponent(character));
    return `background-image:url("${safeUrl}")`;
  }catch{return "";}
}

// ════════════════════════════════════
// CIRCULAR MOSAIC — الفسيفساء الدائرية
// تعرض الأقسام الرئيسية فقط (بدون parentId). الضغط على أي مربع = openCat(cat) كما كان.
// ترتيب الأهمية (حجم المربع): حقل اختياري weight في القسم، ثم عدد المنتجات.
// ════════════════════════════════════
let mzForceList=false;
let mzCustom={};
const MZ_MIN=3, MZ_MAX=23;
const MZ_GRAD=[['#1e3a8a','#3b82f6'],['#3b0764','#7c3aed'],['#0c4a6e','#06b6d4'],['#312e81','#6366f1'],['#4c1d95','#a855f7'],['#164e63','#22d3ee'],['#1e1b4b','#4f46e5'],['#581c87','#c026d3']];
const mzEsc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mzUrl=u=>String(u).replace(/['"\\()<>\s]/g,ch=>encodeURIComponent(ch));
function mzRng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function mzPack(N,S,iters=12000){
  const inGrid=(c,r)=>c>=0&&c<S&&r>=0&&r<S;
  const cells=S*S;
  const rnd=mzRng(N*7919+S*31+13);let best=null,bs=1e9;
  for(let it=0;it<iters;it++){
    const g=Array.from({length:S},()=>Array(S).fill(-1)),tiles=[];let ok=true;
    const free=(c,r,w,h)=>{for(let y=r;y<r+h;y++)for(let x=c;x<c+w;x++)if(!inGrid(x,y)||g[y][x]!==-1)return false;return true};
    outer:for(let r=0;r<S;r++)for(let c=0;c<S;c++){
      if(g[r][c]!==-1)continue;
      if(tiles.length>=N){ok=false;break outer}
      const want=(cells/N)*(0.3+rnd()*2.4),asp=0.55+rnd()*1.2;
      let w=Math.max(1,Math.round(Math.sqrt(want*asp))),h=Math.max(1,Math.round(want/w));
      while(w>1&&!free(c,r,w,1))w--;
      while(h>1&&!free(c,r,w,h))h--;
      for(let y=r;y<r+h;y++)for(let x=c;x<c+w;x++)g[y][x]=tiles.length;
      tiles.push([c,r,w,h]);
    }
    if(!ok||tiles.length!==N)continue;
    let pen=0,mx=0;
    for(const[,,w,h]of tiles){const a=Math.max(w/h,h/w),ar=w*h;mx=Math.max(mx,ar);if(a>2.2)pen+=(a-2.2)*3;if(ar===1)pen+=.8}
    pen-=Math.log(mx)*1.4;
    if(pen<bs){bs=pen;best=tiles}
  }
  return best;
}
// التحقق من عدم التداخل وتغطية كل خلية يتقاطع جزء منها مع دائرة عرض اللاعب
function mzValidLayout(l,N){
  try{
    const S=+l.S;if(!(S>=4&&S<=14))return false;
    if(!Array.isArray(l.boxes)||l.boxes.length!==N)return false;
    const touchesCircle=(c,r)=>{
      const dx=Math.max(Math.abs(c+.5-S/2)-.5,0);
      const dy=Math.max(Math.abs(r+.5-S/2)-.5,0);
      return dx*dx+dy*dy<=(S/2)*(S/2);
    };
    const own=new Set();
    for(const b of l.boxes){
      const c=+b[0],r=+b[1],w=+b[2],h=+b[3];
      if(!(c>=0&&r>=0&&w>=1&&h>=1&&c+w<=S&&r+h<=S))return false;
      for(let y=r;y<r+h;y++)for(let x=c;x<c+w;x++){if(own.has(x+","+y))return false;own.add(x+","+y);}
    }
    for(let r=0;r<S;r++)for(let c=0;c<S;c++)if(touchesCircle(c,r)&&!own.has(c+","+r))return false;
    return true;
  }catch(e){return false;}
}
async function mzLoadLayouts(){
  const {data,error}=await sbClient.from("mosaic_layouts")
    .select("category_count,grid_size,boxes");
  if(error)throw error;
  const layouts={};
  data.forEach(row=>{layouts[row.category_count]={S:row.grid_size,boxes:row.boxes};});
  return layouts;
}
const mzCache={};
function mzLayout(N){
  const cu=mzCustom[N];
  if(cu&&mzValidLayout(cu,N))return {S:+cu.S,boxes:cu.boxes.map(b=>[+b[0],+b[1],+b[2],+b[3]]),pins:cu.boxes.map(b=>b[4]||null)};
  if(mzCache[N]!==undefined)return mzCache[N];
  let res=null,b=null;
  if(N>=14){b=mzPack(N,10);if(b)res={S:10,boxes:b};}
  else if(N>=6){b=mzPack(N,8);if(b)res={S:8,boxes:b};}
  if(!res&&N>=3){b=mzPack(N,6);if(b)res={S:6,boxes:b};}
  return mzCache[N]=res;
}
function mzWeight(c){
  const ids=new Set([c.id]);let grow=true,guard=0;
  while(grow&&guard++<10){grow=false;categoriesData.forEach(x=>{if(x.parentId&&ids.has(x.parentId)&&!ids.has(x.id)){ids.add(x.id);grow=true}})}
  return (Number(c.weight)||0)*100000+products.filter(p=>ids.has(p.categoryId)).length;
}
function mzToggleList(on){mzForceList=!!on;renderCats();}
// فتح قسم/لعبة من الفسيفساء مع بناء مسار التنقّل (breadcrumb) الصحيح للأقسام الأب
function mzOpen(cat){
  const chain=[];let p=cat.parentId,g=0;
  while(p&&g++<10){const pc=categoriesData.find(x=>x.id===p);if(!pc)break;chain.unshift({id:pc.id,name:pc.name});p=pc.parentId;}
  navStack=chain;currentParentId=cat.parentId||null;
  openCat(cat);
}
function mzRender(){
  const box=document.getElementById("mosaicHome"),grid=document.getElementById("catsGrid"),title=document.getElementById("catSectionTitle"),back=document.getElementById("mzBackBtn");
  const set=m=>{box.style.display=m?"block":"none";grid.style.display=m?"none":"";title.style.display=m?"none":""};
  const top=categoriesData.filter(c=>!c.parentId);
  // إن كانت الأقسام الرئيسية قليلة (أقل من 6) ننزل إلى مستوى الألعاب داخلها: كل لعبة = مربع
  let items=top.slice();
  for(let k=0;k<3&&items.length<6;k++){
    const ex=[];
    items.forEach(n=>{const ch=categoriesData.filter(c=>c.parentId===n.id);ex.push(...(ch.length?ch:[n]));});
    if(ex.length===items.length&&ex.every((n,i)=>n.id===items[i].id))break;
    items=ex;
  }
  const can=currentParentId===null&&items.length>=MZ_MIN;
  back.style.display=(can&&mzForceList)?"inline-block":"none";
  if(!can||mzForceList){set(false);return false;}
  items.sort((a,b)=>mzWeight(b)-mzWeight(a));
  let more=false;
  if(items.length>MZ_MAX){items=items.slice(0,MZ_MAX-1);more=true;}
  const n=items.length+(more?1:0);
  const lay=mzLayout(n);
  if(!lay){set(false);return false;}
  set(true);
  const S=lay.S;
  const slots=lay.boxes.map((b,i)=>({b,a:b[2]*b[3],d:Math.hypot(b[0]+b[2]/2-S/2,b[1]+b[3]/2-S/2),pin:lay.pins?lay.pins[i]:null})).sort((x,y)=>y.a-x.a||x.d-y.d);
  if(more)items.push({__more:true,name:"المزيد"});
  // توزيع الأقسام على الخانات: أولاً الأقسام المثبّتة يدوياً (من لوحة الإدارة)، ثم الباقي بترتيب الأهمية (الأكبر للأهم)
  const assigned=new Array(slots.length).fill(null),usedCat=new Set();
  slots.forEach((s,i)=>{if(!s.pin)return;const it=items.find(x=>x.id===s.pin&&!usedCat.has(x));if(it){assigned[i]=it;usedCat.add(it);}});
  const rest=items.filter(x=>!usedCat.has(x));let ri=0;
  slots.forEach((s,i)=>{if(!assigned[i])assigned[i]=rest[ri++];});
  const g=document.getElementById("mzGrid");g.innerHTML="";
  g.style.gridTemplate=`repeat(${S},1fr)/repeat(${S},1fr)`;
  assigned.forEach((cat,i)=>{
    if(!cat)return;
    const [c,r,w,h]=slots[i].b;
    const af=w*h/(S*S),wf=w/S;
    const cls=af<.012?'xs':(h>w&&wf<.13)?'v':af>=.085?'xl':af>=.055?'lg':af>=.035?'md':'sm';
    const hs=[...String(cat.id||cat.name)].reduce((a,ch)=>a+ch.charCodeAt(0),0);
    const gp=MZ_GRAD[hs%MZ_GRAD.length];
    const b=document.createElement("button");
    b.className="mz-tile "+cls;b.title=cat.name||"";b.setAttribute("aria-label",cat.name||"");
    b.style.cssText=`grid-column:${c+1}/span ${w};grid-row:${r+1}/span ${h};--g1:${gp[0]};--g2:${gp[1]};--d:${(.12+Math.hypot(c+w/2-S/2,r+h/2-S/2)*.075*(10/S)).toFixed(2)}s`;
    let sub="",hasImg=false;
    if(cat.__more){sub="كل الأقسام";}
    else{
      const hasCh=categoriesData.some(x=>(x.parentId||null)===cat.id);
      const par=cat.parentId?categoriesData.find(x=>x.id===cat.parentId):null;
      sub=hasCh?"أقسام فرعية ›":(par?par.name+" · ":"")+products.filter(p=>p.categoryId===cat.id).length+" منتج";
      hasImg=!!cat.image;
    }
    const subS=String(sub).split(" · ").pop(); // نسخة قصيرة (عدد المنتجات فقط) للمربعات الصغيرة
    const ic=cat.__more?'grid':'pad';
    let html=hasImg?`<span class="mz-bg" style="background-image:url('${mzUrl(cat.image)}')"></span><span class="mz-shade"></span>`:`<svg class="mz-motif" viewBox="0 0 24 24"><use href="#mzi-${ic}"/></svg>`;
    const nm=mzEsc(cat.name);
    // حجم الخط يتكيّف مع عرض المربع وطول أطول كلمة حتى لا تنكسر الأسماء
    const longest=Math.max(1,...String(cat.name||"").split(/\s+/).map(s=>s.length));
    const base={xl:6,lg:4.6,md:3.7,sm:3.2}[cls]||3;
    const fit=(wf*100*.8)/(longest*.62);
    const fs=cls==='v'?Math.min(2.8,(h/S*100*.62)/(String(cat.name||"").length*.62)):Math.min(base,fit);
    const nmStyle=`font-size:${Math.max(1.9,fs).toFixed(2)}cqw`;
    if(cls==='xs'){}
    else if(cls==='v')html+=`<span class="mz-meta"><b class="mz-nm" style="${nmStyle}">${nm}</b></span>`;
    else if(cls==='sm')html+=`<span class="mz-meta"><b class="mz-nm" style="${nmStyle}">${nm}</b>${w>=3?`<i class="mz-sb">${mzEsc(subS)}</i>`:''}</span>`;
    else if(cls==='xl')html+=`<span class="mz-meta"><b class="mz-nm" style="${nmStyle}">${nm}</b><i class="mz-sb">${mzEsc(sub)}</i></span><span class="mz-go">تصفّح ←</span>`;
    else html+=`<span class="mz-meta"><b class="mz-nm" style="${nmStyle}">${nm}</b><i class="mz-sb">${mzEsc(cls==='lg'?sub:subS)}</i></span>`;
    // الشبكة RTL: الأعمدة الصغيرة = يمين الشاشة. ننحاز بالنص نحو مركز الدائرة كي لا تقصّه الحافة
    if(c+w/2<S/2-.5&&cls!=='xl'&&cls!=='v'&&cls!=='xs')b.classList.add('mz-fl');
    if(r+h/2>S/2+.5)b.classList.add('mz-tp');
    b.innerHTML=html;
    b.onclick=cat.__more?()=>mzToggleList(true):()=>mzOpen(cat);
    g.appendChild(b);
  });
  g.insertAdjacentHTML("beforeend",'<div class="mz-sweep"></div>');
  document.getElementById("mzChip").textContent=n+" قسم · "+products.length+" منتج";
  if(!window._mzTimer){window._mzTimer=setInterval(()=>{const t=document.querySelectorAll("#mzGrid .mz-tile");if(!t.length)return;const e=t[Math.floor(Math.random()*t.length)];e.classList.add("lit");setTimeout(()=>e.classList.remove("lit"),700)},1900);}
  return true;
}

function renderCats(){
  document.getElementById("catsSection").style.display="block";
  document.getElementById("prodsSection").style.display="none";
  if(mzRender())return;
  const visible=categoriesData.filter(c=>(c.parentId||null)===currentParentId);
  const grid=document.getElementById("catsGrid"); grid.innerHTML="";
  const titleEl=document.getElementById("catSectionTitle");
  titleEl.textContent=currentParentId?(categoriesData.find(c=>c.id===currentParentId)?.name||"الأقسام الفرعية"):"تصفح الأقسام";
  if(!visible.length){ const d=document.createElement("div"); d.className="text-xs text-muted"; d.style.gridColumn="1/-1"; d.style.padding="16px 0"; d.textContent="لا توجد أقسام حالياً."; grid.appendChild(d); return; }
  visible.forEach(cat=>{
    const hasCh=categoriesData.some(c=>(c.parentId||null)===cat.id);
    const pCnt=products.filter(p=>p.categoryId===cat.id).length;
    const card=document.createElement("div"); card.className="category-card";
    const sub=hasCh?"أقسام فرعية ›":pCnt+" منتج";
    card.innerHTML=cat.image?`<img class="cat-img" src="${htmlEscapeStore(cat.image)}" alt="${htmlEscapeStore(cat.name)}" onerror="this.style.display='none'"><div class="cat-label">${htmlEscapeStore(cat.name)}<br><span class="cat-sublabel">${sub}</span></div>`:`<div class="cat-img-placeholder">🎮</div><div class="cat-label">${htmlEscapeStore(cat.name)}<br><span class="cat-sublabel">${sub}</span></div>`;
    card.onclick=()=>openCat(cat); grid.appendChild(card);
  });
}

function getPriceDisplay(prod,lv){
  const disc=getVipDisc(lv);
  if(defaultCurrency==="USD"){
    const fUSD=applyDisc(prod.price_usd||0,lv);
    const origUSD=prod.price_usd||0;
    return {fp:fUSD, orig:origUSD, sym:"$", label:"$"+fUSD.toFixed(2), origLabel:origUSD?"$"+origUSD.toFixed(2):"", balCheck:(currentUser?.balance_usd||0)>=fUSD};
  } else {
    const original=prod.price;
    const fp=applyDisc(original,lv);
    return {fp, orig:original, sym:"ل.س", label:fp+" ل.س", origLabel:original+" ل.س", balCheck:(currentUser?.balance_syp||0)>=fp};
  }
}

function renderProds(catId){
  document.getElementById("catsSection").style.display="none";
  document.getElementById("prodsSection").style.display="block";
  const cat=categoriesData.find(c=>c.id===catId);
  document.getElementById("prodSectionTitle").textContent=cat?cat.name:"المنتجات";
  const list=document.getElementById("prodsList"); list.innerHTML="";
  const empty=document.getElementById("prodsEmpty");
  const filtered=products.filter(p=>p.categoryId===catId);
  if(!filtered.length){ empty.style.display="block"; return; } empty.style.display="none";
  const lv=getVipLevel(currentUser), disc=getVipDisc(lv);
  filtered.forEach(prod=>{
    const pd=getPriceDisplay(prod,lv);
    const hasBal=pd.balCheck;
    const card=document.createElement("div"); card.className="product-card"+( (!currentUser||hasBal)? "" : " no-balance");
    const imgS=safeImageCss(prod.image);
    card.innerHTML=`
      <div class="product-image" style="${imgS}"></div>
      <div class="product-info"><div class="product-name">${htmlEscapeStore(prod.name)}</div><div class="product-category">${htmlEscapeStore(getCatName(prod.categoryId))}</div></div>
      <div class="product-right">
        ${disc>0&&pd.origLabel?`<div class="price-original">${pd.origLabel}</div>`:''}
        <div class="product-price">${pd.label}</div>
        ${disc>0?`<div class="vip-tag">خصم ${disc}%</div>`:''}
        ${currentUser&&!hasBal?'<div class="no-bal-tag">رصيد غير كافٍ</div>':''}
      </div>`;
    card.onclick=()=>handleProductClick(prod); list.appendChild(card);
  });
}

function renderSearch(q){
  const qL=q.trim().toLowerCase(); if(!qL){ goHome(); return; }
  document.getElementById("catsSection").style.display="none";
  document.getElementById("prodsSection").style.display="block";
  document.getElementById("prodSectionTitle").textContent=`نتائج البحث عن "${q}"`;
  document.getElementById("breadcrumb").style.display="none";
  const list=document.getElementById("prodsList"); list.innerHTML="";
  const empty=document.getElementById("prodsEmpty");
  const filtered=products.filter(p=>(p.name||"").toLowerCase().includes(qL)||getCatName(p.categoryId).toLowerCase().includes(qL));
  if(!filtered.length){ empty.style.display="block"; return; } empty.style.display="none";
  const lv=getVipLevel(currentUser), disc=getVipDisc(lv);
  filtered.forEach(prod=>{
    const pd=getPriceDisplay(prod,lv);
    const card=document.createElement("div"); card.className="product-card";
    const imgS=safeImageCss(prod.image);
    card.innerHTML=`<div class="product-image" style="${imgS}"></div><div class="product-info"><div class="product-name">${htmlEscapeStore(prod.name)}</div><div class="product-category">${htmlEscapeStore(getCatName(prod.categoryId))}</div></div><div class="product-right">${disc>0?`<div class="price-original">${pd.origLabel}</div>`:''}<div class="product-price">${pd.label}</div>${disc>0?`<div class="vip-tag">خصم ${disc}%</div>`:''}</div>`;
    card.onclick=()=>handleProductClick(prod); list.appendChild(card);
  });
}

// ════════════════════════════════════
// LOAD DATA
// ════════════════════════════════════
async function loadAllData(){
  if(storeLoadPromise){
    storeLoadQueued=true;
    return storeLoadPromise;
  }
  storeLoadPromise=loadAllDataNow();
  return storeLoadPromise;
}

async function loadAllDataNow(){
  showLoading();
  try{
    const [{data:productRows,error:productError},{data:categoryRows,error:categoryError},{data:paymentRows,error:paymentError},{data:bannerRows,error:bannerError}]=await Promise.all([
      sbClient.from("products").select("*").eq("is_active",true).order("created_at",{ascending:true}),
      sbClient.from("categories").select("*").order("created_at",{ascending:true}),
      sbClient.from("payment_methods").select("*").eq("is_active",true).order("sort_order",{ascending:true}),
      sbClient.from("store_banners").select("*").eq("is_active",true).order("sort_order",{ascending:true}),
    ]);
    if(productError)throw productError;
    if(categoryError)throw categoryError;
    const missingSettingsTables=[];
    let availablePaymentRows=paymentRows;
    let availableBannerRows=bannerRows;
    if(paymentError){
      if(isMissingStoreSettingsTable(paymentError,"payment_methods")){
        availablePaymentRows=[];
        missingSettingsTables.push("payment_methods");
      }else throw paymentError;
    }
    if(bannerError){
      if(isMissingStoreSettingsTable(bannerError,"store_banners")){
        availableBannerRows=[];
        missingSettingsTables.push("store_banners");
      }else throw bannerError;
    }
    if(missingSettingsTables.length&&!missingStoreSettingsWarningShown){
      missingStoreSettingsWarningShown=true;
      console.error("Store settings tables are unavailable:",missingSettingsTables);
      showToast("تم تحميل المنتجات، لكن جداول الدفع والبانرات غير موجودة. شغّل ترحيل إعدادات المتجر في Supabase.","error");
    }else if(!missingSettingsTables.length){
      missingStoreSettingsWarningShown=false;
    }
    products=productRows.map(p=>({...p,categoryId:p.category_id,infoFields:p.info_fields}));
    categoriesData=categoryRows.map(c=>({...c,parentId:c.parent_id}));
    paymentMethods=availablePaymentRows;
    storeBanners=availableBannerRows;
    if(currentUser){
      const [{data:orderRows,error:ordersError},{data:depositRows,error:depositsError}]=await Promise.all([
        sbClient.from("orders").select("*").eq("user_id",currentUser.id).order("created_at",{ascending:false}),
        sbClient.from("deposits").select("*").eq("user_id",currentUser.id).order("created_at",{ascending:false}),
      ]);
      if(ordersError)throw ordersError;
      if(depositsError)throw depositsError;
      orders=orderRows;
      deposits=await Promise.all(depositRows.map(async d=>{
        try{return {...d,image_url:await signedReceipt(d.receipt_path)};}
        catch(e){console.error("Receipt access URL failed:",e);return {...d,image_url:""};}
      }));
    }else{
      orders=[];deposits=[];
    }
    mzCustom=await mzLoadLayouts();
    renderCats();renderBanners(storeBanners);
  }catch(e){ console.error(e); showToast("خطأ في تحميل البيانات.","error"); }
  finally{
    hideLoading();
    storeLoadPromise=null;
    if(storeLoadQueued){
      storeLoadQueued=false;
      void loadAllData();
    }
  }
}

// ════════════════════════════════════
// AUTH
// ════════════════════════════════════
async function handleLogin(){
  const email=document.getElementById("loginEmail").value.trim();
  const pw=document.getElementById("loginPassword").value;
  const err=document.getElementById("loginError"); err.textContent="";
  if(!email||!pw){ err.textContent="يرجى إدخال البريد الإلكتروني وكلمة المرور."; return; }
  showLoading();
  try{
    const {data,error}=await sbClient.auth.signInWithPassword({email,password:pw});
    if(error)throw error;
    currentUser=await loadProfile(data.user.id);
    updateUI(); closeModal("loginModal");
    showToast("✅ تم تسجيل الدخول.","success");
    startSync(); renderCats();
    if(!currentUser.phone){ setTimeout(()=>openModal("phoneModal"),800); }
    await loadAllData();
    startStoreRealtime();
  }catch(e){ console.error("Login failed:",e); err.textContent="تعذر تسجيل الدخول. تحقق من البريد وكلمة المرور وتأكيد البريد."; }
  finally{ hideLoading(); }
}

// ════════════════════════════════════
// PHONE UPDATE (for old accounts)
// ════════════════════════════════════
async function handleSavePhone(){
  const phone=document.getElementById("phoneUpdateInput").value.trim();
  const err=document.getElementById("phoneUpdateError"); err.textContent="";
  if(!phone){ err.textContent="يرجى إدخال رقم الهاتف."; return; }
  showLoading();
  try{
    const {error}=await sbClient.from("profiles").update({phone}).eq("id",currentUser.id);
    if(error)throw error;
    currentUser=await loadProfile(currentUser.id); updateUI();
    closeModal("phoneModal"); showToast("✅ تم حفظ رقم الهاتف.","success");
  }catch(e){ console.error("Phone update failed:",e); err.textContent="خطأ أثناء الحفظ."; }
  finally{ hideLoading(); }
}

// ════════════════════════════════════
// DEFAULT CURRENCY
// ════════════════════════════════════
function setDefaultCurrency(cur){
  defaultCurrency=cur;
  localStorage.setItem('nx_currency',cur);
  updateCurrencyUI();
  if(currentParentId) renderProds(currentParentId);
}
function updateCurrencyUI(){
  document.getElementById("btnCurSYP_profile")?.classList.toggle("active",defaultCurrency==="SYP");
  document.getElementById("btnCurUSD_profile")?.classList.toggle("active",defaultCurrency==="USD");
}

async function handleRegister(){
  const un=document.getElementById("registerUsername").value.trim();
  const email=document.getElementById("registerEmail").value.trim();
  const phone=document.getElementById("registerPhone").value.trim();
  const pw=document.getElementById("registerPassword").value;
  const err=document.getElementById("registerError"); err.textContent="";
  if(!un||!email||!pw){ err.textContent="يرجى إدخال الاسم والبريد الإلكتروني وكلمة المرور."; return; }
  if(!phone){ err.textContent="يرجى إدخال رقم الهاتف."; return; }
  if(pw.length<8){ err.textContent="كلمة المرور 8 أحرف على الأقل."; return; }
  showLoading();
  try{
    const {data,error}=await sbClient.auth.signUp({
      email,password:pw,options:{data:{username:un,phone}},
    });
    if(error)throw error;
    if(data.session){
      currentUser=await loadProfile(data.user.id);
      updateUI();startSync();await loadAllData();
      startStoreRealtime();
    }
    closeModal("registerModal");
    showToast("✅ أُنشئ الحساب. تحقق من بريدك الإلكتروني لتأكيده ثم سجّل الدخول.","success");
  }catch(e){
    console.error("Registration failed:",e);
    err.textContent=e.code==="23505"||e.message?.includes("profiles_username_lower_unique")
      ?"اسم المستخدم موجود.":"تعذر إنشاء الحساب. تحقق من البريد الإلكتروني وحاول باسم مستخدم آخر.";
  }
  finally{ hideLoading(); }
}

// ════════════════════════════════════
// PURCHASE
// ════════════════════════════════════
async function handleProductClick(prod){
  if(!currentUser){ showToast("يرجى تسجيل الدخول أولاً.","error"); openModal("loginModal"); return; }
  await syncUser();
  const lv=getVipLevel(currentUser), disc=getVipDisc(lv);
  const pd=getPriceDisplay(prod,lv);
  if(!pd.balCheck){ showToast(`❌ رصيدك (${defaultCurrency}) غير كافٍ.`,"error"); return; }
  pendingProduct={...prod,finalPrice:pd.fp,currency:defaultCurrency};
  // Collect product info fields
  if(prod.infoFields && prod.infoFields.length>0){
    openProductInfoModal(prod, pd, disc);
    return;
  }
  pendingProduct={...prod,finalPrice:pd.fp,currency:defaultCurrency};
  showConfirmModal(prod, pd, disc, {});
}

function openProductInfoModal(prod, pd, disc){
  // Build form for product info fields
  let html=`<div class="modal-header"><div class="modal-title">معلومات الطلب</div><button class="modal-close" data-modal="productInfoModal">×</button></div>`;
  html+=`<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">يرجى إدخال المعلومات المطلوبة لإتمام الطلب:</p>`;
  (prod.infoFields||[]).forEach(field=>{
    const inputType = field.type==='number'?'number': field.type==='url'?'url':'text';
    html+=`<div class="form-group">
      <label class="form-label">${htmlEscapeStore(field.name)}</label>
      <input type="${inputType}" class="form-input" id="infoField_${htmlEscapeStore(field.id)}" placeholder="${htmlEscapeStore(field.placeholder||'')}" />
    </div>`;
  });
  html+=`<div class="text-xs text-error" id="infoFieldsError"></div>`;
  html+=`<div class="modal-actions">
    <button class="btn btn-outline btn-sm" data-modal="productInfoModal">إلغاء</button>
    <button class="btn btn-primary btn-sm" id="btnConfirmInfoFields">متابعة ←</button>
  </div>`;
  let modal=document.getElementById("productInfoModal");
  if(!modal){
    modal=document.createElement("div");
    modal.className="modal-backdrop";
    modal.id="productInfoModal";
    modal.innerHTML=`<div class="modal">${html}</div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-modal]").forEach(b=>b.onclick=()=>closeModal("productInfoModal"));
  } else {
    modal.querySelector(".modal").innerHTML=html;
    modal.querySelectorAll("[data-modal]").forEach(b=>b.onclick=()=>closeModal("productInfoModal"));
  }
  openModal("productInfoModal");
  document.getElementById("btnConfirmInfoFields").onclick=()=>{
    const infoData={};
    let valid=true;
    (prod.infoFields||[]).forEach(field=>{
      const val=document.getElementById("infoField_"+field.id)?.value?.trim()||"";
      if(!val){ valid=false; }
      infoData[field.name]=val;
    });
    if(!valid){ document.getElementById("infoFieldsError").textContent="يرجى ملء جميع الحقول."; return; }
    closeModal("productInfoModal");
    pendingProduct={...prod,finalPrice:pd.fp,currency:defaultCurrency,infoData};
    showConfirmModal(prod, pd, disc, infoData);
  };
}

function showConfirmModal(prod, pd, disc, infoData){
  const balKey=defaultCurrency==="USD"?"balance_usd":"balance_syp";
  const curBal=currentUser[balKey]||0;
  const after=curBal-pd.fp;
  const imgS=safeImageCss(prod.image);
  document.getElementById("confirmRow").innerHTML=`<div class="confirm-prod-img" style="${imgS};background-size:cover;background-position:center;"></div><div><div class="confirm-prod-name">${htmlEscapeStore(prod.name)}</div><div class="confirm-prod-price">${pd.label}${disc>0?` <span style="font-size:11px;color:var(--gold)">(خصم ${disc}%)</span>`:''}</div></div>`;
  let infoRows="";
  if(infoData && Object.keys(infoData).length>0){
    infoRows+=Object.entries(infoData).map(([k,v])=>`<div class="bal-row"><span>${htmlEscapeStore(k)}</span><span style="color:var(--accent2);font-size:12px;">${htmlEscapeStore(v)}</span></div>`).join("");
  }
  document.getElementById("confirmBalRows").innerHTML=`
    <div class="bal-row"><span>رصيدك الحالي (${defaultCurrency})</span><span>${curBal.toLocaleString()} ${pd.sym}</span></div>
    <div class="bal-row"><span>سعر المنتج</span><span>- ${pd.label}</span></div>
    <div class="bal-row"><span>الرصيد بعد الشراء</span><span style="color:var(--green)">${after.toFixed(defaultCurrency==="USD"?2:0)} ${pd.sym}</span></div>
    ${infoRows}`;
  openModal("confirmModal");
}

async function executePurchase(){
  const prod=pendingProduct; if(!prod||purchaseInProgress) return;
  purchaseInProgress=true;
  closeModal("confirmModal"); showLoading();
  const cur=prod.currency||"SYP";
  const infoData=prod.infoData||{};
  let purchaseCommitted=false;
  try{
    const {data:order,error}=await sbClient.rpc("purchase_product",{
      p_product_id:prod.id,p_currency:cur,
      p_info_data:infoData,
    });
    if(error)throw error;
    purchaseCommitted=true;
    orders.unshift(order);
    try{
      currentUser=await loadProfile(currentUser.id);
      updateUI();
    }catch(e){console.error("Purchase succeeded but profile refresh failed:",e);}
    try{await notifyTelegram("order",order.id);}
    catch(e){console.error("Purchase succeeded but Telegram notification failed:",e);}

    showToast("✅ تم إنشاء الطلب! سيتم مراجعته.","success");
    pushNotification('🛒','تم إنشاء طلبك!','سيتم مراجعة طلبك قريباً: '+prod.name,'info');
    seenOrderStatuses[order.id]='pending'; saveNotifState();
    if(currentParentId) renderProds(currentParentId);
  }catch(e){
    console.error("Purchase failed:",e);
    showToast(purchaseCommitted
      ?"تم الشراء، لكن تعذر تحديث بعض البيانات. تحقق من سجل الطلبات."
      :e.message?.includes("Insufficient balance")?"❌ رصيدك غير كافٍ.":"خطأ أثناء الشراء. لم يتم تنفيذ العملية.","error");
  }
  finally{ hideLoading(); pendingProduct=null; purchaseInProgress=false; }
}

// ════════════════════════════════════
// DEPOSIT MULTI-STEP
// ════════════════════════════════════
function resetDeposit(){
  depMethod=null; depCurrency=null; goDepStep(1);
  document.getElementById("depositAmount").value="";
  document.getElementById("depositImage").value="";
  document.getElementById("depositError").textContent="";
  document.getElementById("depositCustomFields").replaceChildren();
  renderPaymentMethods();
}
function goDepStep(n){
  document.querySelectorAll(".deposit-step").forEach(s=>s.classList.remove("active"));
  document.getElementById("depStep"+n)?.classList.add("active");
  document.getElementById("depModalTitle").textContent={1:"شحن الرصيد",2:"اختر العملة",3:"تفاصيل التحويل"}[n]||"شحن الرصيد";
}
function renderPaymentMethods(){
  const grid=document.getElementById("depositMethodsGrid");
  const empty=document.getElementById("depositMethodsEmpty");
  const methods=paymentMethods.filter(method=>method.is_active);
  grid.replaceChildren();empty.hidden=methods.length>0;
  methods.forEach(method=>{
    const card=document.createElement("button");
    card.type="button";card.className="method-card"+(depMethod?.id===method.id?" selected":"");
    const icon=method.image_url
      ?`<img class="method-store-image" src="${htmlEscape(method.image_url)}" alt="">`
      :'<div class="method-icon">💳</div>';
    card.innerHTML=`${icon}<div class="method-name">${htmlEscape(method.name)}</div>
      <div class="method-sub">${(method.currencies||[]).map(currency=>currency==="USD"?"USD":"ل.س").join(" / ")}</div>
      ${method.description?`<div class="method-sub">${htmlEscape(method.description)}</div>`:""}`;
    card.onclick=()=>selectMethod(method.id);
    grid.appendChild(card);
  });
}

function selectMethod(methodId){
  depMethod=paymentMethods.find(method=>method.id===methodId&&method.is_active)||null;
  if(!depMethod){showToast("طريقة الدفع لم تعد متاحة. حدّث الصفحة وحاول مجدداً.","error");return;}
  const currencies=depMethod.currencies||[];
  if(currencies.length===1){selectCurrency(currencies[0]);return;}
  renderDepositCurrencies();goDepStep(2);
}

function renderDepositCurrencies(){
  const container=document.getElementById("depositCurrencies");container.replaceChildren();
  (depMethod?.currencies||[]).forEach(currency=>{
    const button=document.createElement("button");
    button.type="button";button.className="currency-btn";
    button.textContent=currency==="USD"?"🇺🇸 دولار أمريكي":"🇸🇾 ليرة سورية";
    button.onclick=()=>selectCurrency(currency);container.appendChild(button);
  });
}

function selectCurrency(currency){
  if(!depMethod||!(depMethod.currencies||[]).includes(currency))return;
  depCurrency=currency;
  loadDepStep3();goDepStep(3);
}

const htmlEscapeStore=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
function loadDepStep3(){
  if(!depMethod)return;
  document.getElementById("depMethodBadge").textContent=`${depMethod.name} · ${depCurrency}`;
  const image=document.getElementById("depQrImg");
  if(depMethod.image_url){image.src=depMethod.image_url;image.style.display="block";}
  else{image.removeAttribute("src");image.style.display="none";}
  document.getElementById("depMethodDescription").textContent=depMethod.description||"";
  document.getElementById("depInstructions").textContent=depMethod.instructions||"";
  const destinationWrap=document.getElementById("depDestinationWrap");
  document.getElementById("depWalletAddr").textContent=depMethod.destination||"";
  destinationWrap.hidden=!depMethod.destination;
  document.getElementById("depAmountLabel").textContent=depCurrency==="USD"?"المبلغ (USD $)":"المبلغ (ل.س)";
  const customFields=document.getElementById("depositCustomFields");customFields.replaceChildren();
  (depMethod.fields||[]).forEach(field=>{
    const group=document.createElement("div");group.className="form-group";
    const safeLabel=htmlEscapeStore(field.label);
    let input;
    if(field.type==="select"){
      input=document.createElement("select");input.className="form-input";
      const placeholder=document.createElement("option");placeholder.value="";placeholder.textContent="اختر...";
      input.appendChild(placeholder);
      (field.options||[]).forEach(option=>{
        const choice=document.createElement("option");choice.value=option;choice.textContent=option;input.appendChild(choice);
      });
    }else{
      input=document.createElement("input");input.className="form-input";
      input.type=["text","number","tel","email"].includes(field.type)?field.type:"text";
    }
    input.dataset.paymentFieldKey=field.key;
    input.required=!!field.required;input.maxLength=500;
    group.innerHTML=`<label class="form-label">${safeLabel}${field.required?" *":""}</label>`;
    group.appendChild(input);customFields.appendChild(group);
  });
}

function copyWallet(){
  const text=document.getElementById("depWalletAddr").textContent;
  if(!text)return;
  navigator.clipboard.writeText(text)
    .then(()=>showToast("✅ تم نسخ العنوان!","success")).catch(()=>showToast("تعذر النسخ","error"));
}
async function handleDepositSubmit(){
  if(!currentUser){ showToast("يرجى تسجيل الدخول أولاً.","error"); return; }
  if(depositInProgress)return;
  const amount=Number(document.getElementById("depositAmount").value);
  const file=document.getElementById("depositImage").files[0];
  const err=document.getElementById("depositError"); err.textContent="";
  if(!amount||amount<=0){ err.textContent="يرجى إدخال مبلغ صحيح."; return; }
  if(!file){ err.textContent="يرجى رفع صورة إثبات التحويل."; return; }
  if(!depMethod||!depCurrency){ err.textContent="يرجى اختيار طريقة الدفع والعملة."; return; }
  const selectedMethod=paymentMethods.find(method=>method.id===depMethod.id&&method.is_active);
  if(!selectedMethod){err.textContent="طريقة الدفع لم تعد متاحة؛ ارجع واختر طريقة أخرى.";return;}
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>5*1024*1024){
    err.textContent="ارفع صورة JPG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت.";return;
  }
  const paymentDetails={};
  for(const field of selectedMethod.fields||[]){
    const input=[...document.querySelectorAll("[data-payment-field-key]")].find(item=>item.dataset.paymentFieldKey===field.key);
    const value=input?.value?.trim()||"";
    if(field.required&&!value){err.textContent=`يرجى تعبئة الحقل «${field.label}».`;input?.focus();return;}
    if(value)paymentDetails[field.key]=value;
  }
  depositInProgress=true;
  showLoading();
  let receiptPath="",depositCommitted=false;
  try{
    const extension={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"}[file.type];
    receiptPath=`${currentUser.id}/${crypto.randomUUID()}.${extension}`;
    const {error:uploadError}=await sbClient.storage.from("transfer-receipts")
      .upload(receiptPath,file,{contentType:file.type,upsert:false});
    if(uploadError)throw uploadError;
    const {data:deposit,error}=await sbClient.rpc("request_deposit",{
      p_amount:amount,p_currency:depCurrency,p_method_id:selectedMethod.id,
      p_receipt_path:receiptPath,p_payment_details:paymentDetails,
    });
    if(error)throw error;
    depositCommitted=true;
    let imageUrl="";
    try{imageUrl=await signedReceipt(deposit.receipt_path);}
    catch(e){console.error("Receipt access URL failed:",e);}
    deposits.unshift({...deposit,image_url:imageUrl});
    await notifyTelegram("deposit",deposit.id);
    closeModal("depositModal"); resetDeposit();
    showToast("✅ تم إرسال طلب الشحن للمراجعة.","success");
    pushNotification('💳','طلب شحن مُرسل','سيتم مراجعة طلبك وإضافة الرصيد قريباً','info');
  }catch(e){
    console.error("Deposit submission failed:",e);
    if(!depositCommitted&&receiptPath){
      const {data:existing,error:lookupError}=await sbClient.from("deposits")
        .select("id").eq("receipt_path",receiptPath).maybeSingle();
      if(lookupError){
        console.error("Could not verify deposit request after an error:",lookupError);
        err.textContent="تعذر التأكد من وصول الطلب. تحقّق من سجل الإيداعات قبل إعادة المحاولة.";
        return;
      }
      if(existing){
        depositCommitted=true;
        await loadAllData();
        closeModal("depositModal");resetDeposit();
        showToast("تم إرسال طلب الشحن للمراجعة.","success");
        return;
      }
      const {error:removeError}=await sbClient.storage.from("transfer-receipts").remove([receiptPath]);
      if(removeError)console.error("Failed to remove unused receipt:",removeError);
    }
    if(depositCommitted){
      await loadAllData();
      err.textContent="تم تسجيل طلب الشحن. تحقّق من سجل الإيداعات قبل إرسال طلب آخر.";
    }else{
      err.textContent="خطأ أثناء إرسال الطلب. لم يتم إنشاء طلب الشحن.";
    }
  }
  finally{ hideLoading();depositInProgress=false; }
}

// ════════════════════════════════════
// HISTORY
// ════════════════════════════════════
function renderOrdersHist(){
  const c=document.getElementById("ordersHistory"); c.innerHTML="";
  if(!currentUser){ c.innerHTML='<div class="text-xs text-error">يرجى تسجيل الدخول.</div>'; return; }
  const list=orders.filter(o=>o.user_id===currentUser.id).slice().reverse();
  if(!list.length){ c.innerHTML='<div class="text-xs text-muted">لا توجد طلبات حالياً.</div>'; return; }
  const sm={pending:"⏳ قيد المراجعة",completed:"✅ مكتمل",cancelled:"❌ ملغي",processing:"🔄 قيد التنفيذ"};
  list.forEach(o=>{
    const d=document.createElement("div");d.className="history-item";
    const cur=o.currency==="USD"?"$":"ل.س";
    d.innerHTML=`<div><strong>${htmlEscapeStore(o.product_name)}</strong> — ${o.price} ${cur}</div>
      <div class="text-xs text-muted">${sm[o.status]||o.status}</div>
      <div class="text-xs text-muted">${new Date(o.created_at).toLocaleString("ar-EG")}</div>`;
    c.appendChild(d);
  });
}
function renderDepositsHist(){
  const c=document.getElementById("depositsHistory"); c.innerHTML="";
  if(!currentUser){ c.innerHTML='<div class="text-xs text-error">يرجى تسجيل الدخول.</div>'; return; }
  const list=deposits.filter(d=>d.user_id===currentUser.id).slice().reverse();
  if(!list.length){ c.innerHTML='<div class="text-xs text-muted">لا توجد إيداعات حالياً.</div>'; return; }
  const sm={pending:"⏳ قيد المراجعة",completed:"✅ مقبول",cancelled:"❌ مرفوض"};
  list.forEach(d=>{ const el=document.createElement("div"); el.className="history-item"; const cur=d.currency==="USD"?"$":"ل.س"; el.innerHTML=`<div><strong>${d.amount} ${cur}</strong>${d.method?` — ${d.method}`:''}</div><div class="text-xs text-muted">${sm[d.status]||d.status}</div><div class="text-xs text-muted">${new Date(d.created_at).toLocaleString("ar-EG")}</div>${d.image_url?`<a href="${d.image_url}" target="_blank">عرض صورة التحويل</a>`:''}`; c.appendChild(el); });
}

// ════════════════════════════════════
// EVENTS
// ════════════════════════════════════
document.getElementById("btnDrawerToggle").onclick=()=>{openModal("drawerBackdrop");lucide.createIcons();};
document.getElementById("drawerBackdrop").onclick=e=>{if(e.target.id==="drawerBackdrop")closeModal("drawerBackdrop");};
document.getElementById("btnOpenLogin").onclick=()=>openModal("loginModal");
document.getElementById("btnOpenRegister").onclick=()=>openModal("registerModal");
document.getElementById("btnOpenDeposit").onclick=()=>{resetDeposit();openModal("depositModal");};
document.getElementById("navDeposit").onclick=()=>{ if(!currentUser){showToast("يرجى تسجيل الدخول أولاً.","error");openModal("loginModal");return;} resetDeposit();openModal("depositModal"); };
document.getElementById("btnLoginSubmit").onclick=handleLogin;
document.getElementById("btnRegisterSubmit").onclick=handleRegister;
document.getElementById("btnDepositSubmit").onclick=handleDepositSubmit;
document.getElementById("depBack3").onclick=()=>goDepStep(depMethod?.currencies?.length>1?2:1);
document.getElementById("btnConfirmBuy").onclick=executePurchase;
document.getElementById("btnLogout").onclick=async()=>{ if(confirm("تأكيد تسجيل الخروج؟")){ stopSync(); const {error}=await sbClient.auth.signOut(); if(error){console.error("Sign out failed:",error);showToast("تعذر تسجيل الخروج.","error");return;} currentUser=null; startStoreRealtime(); updateUI(); closeModal("drawerBackdrop"); showToast("تم تسجيل الخروج."); } };
document.querySelectorAll(".modal-close,[data-modal]").forEach(btn=>{ btn.onclick=()=>{const id=btn.getAttribute("data-modal")||btn.getAttribute("data-close-modal");if(id)closeModal(id);}; });
document.getElementById("linkHome").onclick=()=>{closeModal("drawerBackdrop");goHome();};
document.getElementById("navHome").onclick=goHome;
document.getElementById("linkPurchases").onclick=()=>{
  closeModal("drawerBackdrop");
  if(!currentUser){showToast("يرجى تسجيل الدخول.","error");openModal("loginModal");return;}
  document.getElementById("historyTitle").textContent="سجل المشتريات";
  document.getElementById("historyHint").textContent="";
  document.querySelectorAll("[data-ht]").forEach(t=>t.classList.remove("active"));
  document.querySelector('[data-ht="orders"]').classList.add("active");
  document.getElementById("ordersHistory").style.display="flex";
  document.getElementById("depositsHistory").style.display="none";
  renderOrdersHist();renderDepositsHist();openModal("historyModal");
};
document.getElementById("linkSupport").onclick=()=>{ closeModal("drawerBackdrop"); openModal("contactModal"); lucide.createIcons(); };
document.getElementById("navInfo").onclick=()=>{ openModal("infoModal"); lucide.createIcons(); };
document.getElementById("navContact").onclick=()=>{openModal("contactModal");lucide.createIcons();};
document.getElementById("navSearch").onclick=()=>document.getElementById("searchInput").focus();
document.querySelectorAll("[data-ht]").forEach(tab=>{ tab.onclick=()=>{ const t=tab.getAttribute("data-ht"); document.querySelectorAll("[data-ht]").forEach(x=>x.classList.remove("active")); tab.classList.add("active"); if(t==="orders"){document.getElementById("ordersHistory").style.display="flex";document.getElementById("depositsHistory").style.display="none";renderOrdersHist();}else{document.getElementById("ordersHistory").style.display="none";document.getElementById("depositsHistory").style.display="flex";renderDepositsHist();} }; });
let _st; document.getElementById("searchInput").oninput=()=>{ clearTimeout(_st); _st=setTimeout(()=>{const q=document.getElementById("searchInput").value.trim();q?renderSearch(q):goHome();},300); };
document.getElementById("loginPassword").onkeyup=e=>{if(e.key==="Enter")handleLogin();};
document.getElementById("btnSavePhone").onclick=handleSavePhone;
document.getElementById("btnSkipPhone").onclick=()=>closeModal("phoneModal");

// Notification events
document.getElementById("btnNotif").onclick=(e)=>{
  e.stopPropagation();
  const panel=document.getElementById("notifPanel");
  panel.classList.toggle("open");
  if(panel.classList.contains("open")){
    // Mark all as read after 2s
    setTimeout(()=>{
      notifications.forEach(n=>n.read=true);
      saveNotifState(); updateNotifBadge(); renderNotifPanel();
    },2000);
  }
};
document.addEventListener("click",(e)=>{
  const panel=document.getElementById("notifPanel");
  const btn=document.getElementById("btnNotif");
  if(panel&&!panel.contains(e.target)&&e.target!==btn&&!btn.contains(e.target)){
    panel.classList.remove("open");
  }
});
document.getElementById("btnClearNotif").onclick=clearAllNotifs;
document.getElementById("inappClose").onclick=()=>document.getElementById("inappNotif").classList.remove("show");

// ════════════════════════════════════
// INIT
// ════════════════════════════════════
(async()=>{
  loadNotifState();
  ["nx_user","nx_products","nx_categories","nx_layouts"].forEach(key=>localStorage.removeItem(key));
  defaultCurrency=localStorage.getItem('nx_currency')||'SYP';
  updateUI();
  updateCurrencyUI();
  renderNotifPanel();
  updateNotifBadge();

  // amr dev link
  const devLink=document.getElementById("amrDevLink");
  if(devLink) devLink.href=AMR_DEV_URL;
  // Store logo
  if(STORE_LOGO_URL){
    const logoImg=document.getElementById("storeLogo");
    const logoFallback=document.getElementById("storeLogoFallback");
    if(logoImg){
      logoImg.src=STORE_LOGO_URL;
      logoImg.alt=STORE_NAME;
      logoImg.style.display="block";
      logoImg.onerror=()=>{logoImg.style.display="none";if(logoFallback)logoFallback.style.display="";};
    }
    if(logoFallback) logoFallback.style.display="none";
  }
  // Store name — title, header, logo fallback initials
  document.title=STORE_NAME;
  document.querySelectorAll(".main-name").forEach(el=>el.textContent=STORE_NAME);
  // Logo fallback: use first letters of each word (max 3)
  const storeLogoFallback=document.getElementById("storeLogoFallback");
  if(storeLogoFallback){
    const initials=STORE_NAME.split(/\s+/).map(w=>w[0]).join("").toUpperCase().slice(0,3);
    storeLogoFallback.textContent=initials;
  }
  // Contact info from config
  const tgEl=document.getElementById("contactTelegram");
  const waEl=document.getElementById("contactWhatsapp");
  if(tgEl){ tgEl.href=CONTACT_TELEGRAM; }
  const tgHandle=document.getElementById("contactTelegramHandle");
  if(tgHandle) tgHandle.textContent=CONTACT_TELEGRAM_HANDLE;
  if(waEl){ waEl.href="https://wa.me/"+CONTACT_WHATSAPP_NUMBER; }
  const waHandle=document.getElementById("contactWhatsappHandle");
  if(waHandle) waHandle.textContent="+"+CONTACT_WHATSAPP_NUMBER;

  const {data:authData,error:authError}=await sbClient.auth.getSession();
  if(authError)throw authError;
  if(authData.session){
    try{
      currentUser=await loadProfile(authData.session.user.id);
    }catch(e){
      console.error("Failed to load signed-in profile:",e);
      await sbClient.auth.signOut();
    }
  }
  updateUI();
  await loadAllData();
  startStoreRealtime();
  // Initialize seenOrderStatuses from existing orders
  if(currentUser){
    orders.filter(o=>o.user_id===currentUser.id).forEach(o=>{
      if(!seenOrderStatuses[o.id]) seenOrderStatuses[o.id]=o.status;
    });
    saveNotifState();
    startSync();
  }
  // Render all Lucide icons
  lucide.createIcons();
})();
