// VIP Levels (must match index.html VIP_LEVELS)
const VIP_LEVELS_ADMIN = [
  { level: 0, name: "VIP 0", discount: 0, desc: "المستوى الافتراضي" },
  { level: 1, name: "VIP 1", discount: 3, desc: "خصم 3% على جميع المنتجات" },
  { level: 2, name: "VIP 2", discount: 5, desc: "خصم 5% على جميع المنتجات" },
];

// ============================
// HELPERS
// ============================
function showToast(msg,type='info'){
  const t=document.getElementById("toast");
  t.textContent=msg;
  const c={error:'rgba(239,68,68,0.4)',success:'rgba(34,197,94,0.4)',info:'rgba(59,130,246,0.3)'};
  t.style.borderColor=c[type]||c.info; t.style.opacity="1"; clearTimeout(t._t);
  t._t=setTimeout(()=>t.style.opacity="0",3000);
}
const htmlEscape=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
function showLoading(){document.getElementById("loadingOverlay").classList.add("show");}
function hideLoading(){document.getElementById("loadingOverlay").classList.remove("show");}
function closeModal(id){
  document.getElementById(id).classList.remove("open");
  if(id==="catModal"){
    const categoryId=document.getElementById("catId").value;
    resetCatalogImage("category",categoriesData.find(category=>category.id===categoryId)?.image||null);
  }
  if(id==="productModal"){
    const productId=document.getElementById("productId").value;
    resetCatalogImage("product",products.find(product=>product.id===productId)?.image||null);
  }
  if(id==="paymentMethodModal"){
    const methodId=document.getElementById("paymentMethodId").value;
    resetPaymentMethodImage(paymentMethods.find(method=>method.id===methodId)?.image_url||null);
  }
}
function openModal(id){document.getElementById(id).classList.add("open");}
function badge(status){const m={pending:'<span class="badge badge-pending">⏳ معلق</span>',completed:'<span class="badge badge-completed">✅ مكتمل</span>',cancelled:'<span class="badge badge-cancelled">❌ ملغي</span>',processing:'<span class="badge badge-processing">🔄 جاري</span>'};return m[status]||`<span class="badge badge-pending">${status}</span>`;}

function vipBadgeAdmin(level){
  const v=VIP_LEVELS_ADMIN.find(x=>x.level===level)||VIP_LEVELS_ADMIN[0];
  const cls=`vip-a-${Math.min(level,3)}`;
  return `<span class="vip-badge-admin ${cls}">${v.name}</span>`;
}

function applyAdminBranding(){
  const initials=STORE_NAME.split(/\s+/).map(word=>word[0]).join("").toUpperCase().slice(0,3);
  document.title=`${STORE_NAME} | لوحة الإدارة`;
  ["adminLoginStoreName","adminMobileStoreName","adminSidebarStoreName"]
    .forEach(id=>{document.getElementById(id).textContent=STORE_NAME;});
  ["adminLoginLogoFallback","adminSidebarLogoFallback"]
    .forEach(id=>{document.getElementById(id).textContent=initials;});
  ["adminLoginLogo","adminMobileLogo","adminSidebarLogo"].forEach(id=>{
    const logo=document.getElementById(id);
    if(!STORE_LOGO_URL)return;
    logo.src=STORE_LOGO_URL;
    logo.alt=STORE_NAME;
    logo.onerror=()=>{
      logo.style.display="none";
      const fallbackId=id==="adminLoginLogo"?"adminLoginLogoFallback"
        :id==="adminSidebarLogo"?"adminSidebarLogoFallback":null;
      if(fallbackId)document.getElementById(fallbackId).hidden=false;
    };
  });
  if(STORE_LOGO_URL){
    document.getElementById("adminLoginLogoFallback").hidden=true;
    document.getElementById("adminSidebarLogoFallback").hidden=true;
  }
}

applyAdminBranding();

// ============================
// STATE
// ============================
let users=[],products=[],orders=[],deposits=[],categoriesData=[],ledger=[],auditLogs=[],paymentMethods=[],storeBanners=[];
let adminProfile=null,adminRealtimeChannel=null,adminRealtimeTimer=null;
let adminLoadPromise=null,adminLoadQueued=false,paymentBannerSaving=false;
let missingAdminSettingsWarningShown=false;
let paymentMethodImageUrl=null,paymentMethodImageObjectUrl=null,bannerImageObjectUrl=null;
const CATALOG_IMAGE_BUCKET="product-images";
const CATALOG_IMAGE_MAX_BYTES=5*1024*1024;
function isMissingAdminSettingsTable(error,table){
  const description=[error?.message,error?.details,error?.hint].filter(Boolean).join(" ").toLowerCase();
  return description.includes(table)&&(
    error?.code==="PGRST205"||
    (error?.status===404&&description.includes("schema cache"))
  );
}

const catalogImageState={
  category:{file:null,currentUrl:null,clear:false,objectUrl:null,inputId:"catImageFile",previewId:"catImgPreview",removeId:"catImageRemove",errorId:"catModalError"},
  product:{file:null,currentUrl:null,clear:false,objectUrl:null,inputId:"productImageFile",previewId:"productImgPreview",removeId:"productImageRemove",errorId:"productModalError"},
};

async function signedReceipt(path){
  if(!path)return "";
  const {data,error}=await sbClient.storage.from("transfer-receipts").createSignedUrl(path,3600);
  if(error)throw error;
  return data.signedUrl;
}

async function notifyTelegram(kind,id){
  try{
    const {error}=await sbClient.functions.invoke("notify-telegram",{body:{kind,id}});
    if(error)throw error;
    return true;
  }catch(e){console.error("Telegram notification failed:",e);return false;}
}

function resetCatalogImage(kind,url=null){
  const state=catalogImageState[kind];
  if(state.objectUrl){URL.revokeObjectURL(state.objectUrl);state.objectUrl=null;}
  state.file=null;state.currentUrl=url||null;state.clear=false;
  document.getElementById(state.inputId).value="";
  const preview=document.getElementById(state.previewId);
  if(url){preview.src=url;preview.style.display="block";}
  else{preview.removeAttribute("src");preview.style.display="none";}
  const removeButton=document.getElementById(state.removeId);
  removeButton.hidden=!url;
  removeButton.textContent="إزالة الصورة";
}

function handleCatalogImageChange(kind,input){
  const state=catalogImageState[kind];
  const error=document.getElementById(state.errorId);
  error.textContent="";
  const file=input.files?.[0];
  if(!file)return;
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>CATALOG_IMAGE_MAX_BYTES){
    input.value="";
    if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
    state.objectUrl=null;state.file=null;state.clear=false;
    const preview=document.getElementById(state.previewId);
    if(state.currentUrl){preview.src=state.currentUrl;preview.style.display="block";}
    else{preview.removeAttribute("src");preview.style.display="none";}
    const removeButton=document.getElementById(state.removeId);
    removeButton.hidden=!state.currentUrl;removeButton.textContent="إزالة الصورة";
    error.textContent="اختر JPG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت.";
    showToast("اختر صورة JPG أو PNG أو WebP بحجم لا يتجاوز 5 ميغابايت.","error");
    return;
  }
  if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
  state.file=file;state.clear=false;state.objectUrl=URL.createObjectURL(file);
  const preview=document.getElementById(state.previewId);
  preview.src=state.objectUrl;preview.style.display="block";
  const removeButton=document.getElementById(state.removeId);
  removeButton.hidden=false;removeButton.textContent="إلغاء التغيير";
}

function clearCatalogImage(kind){
  const state=catalogImageState[kind];
  if(state.file){
    if(state.objectUrl){URL.revokeObjectURL(state.objectUrl);state.objectUrl=null;}
    state.file=null;state.clear=false;
    document.getElementById(state.inputId).value="";
    const preview=document.getElementById(state.previewId);
    if(state.currentUrl){preview.src=state.currentUrl;preview.style.display="block";}
    else{preview.removeAttribute("src");preview.style.display="none";}
    const removeButton=document.getElementById(state.removeId);
    removeButton.hidden=!state.currentUrl;removeButton.textContent="إزالة الصورة";
    return;
  }
  if(state.objectUrl){URL.revokeObjectURL(state.objectUrl);state.objectUrl=null;}
  document.getElementById(state.inputId).value="";
  const preview=document.getElementById(state.previewId);
  if(state.clear){
    state.clear=false;
    if(state.currentUrl){preview.src=state.currentUrl;preview.style.display="block";}
    else{preview.removeAttribute("src");preview.style.display="none";}
    document.getElementById(state.removeId).hidden=!state.currentUrl;
    document.getElementById(state.removeId).textContent="إزالة الصورة";
    return;
  }
  state.clear=true;
  preview.removeAttribute("src");preview.style.display="none";
  const removeButton=document.getElementById(state.removeId);
  removeButton.hidden=!state.currentUrl;
  removeButton.textContent="إلغاء إزالة الصورة";
}

async function uploadCatalogImage(kind,file){
  const extension={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"}[file.type];
  const path=`${kind}/${crypto.randomUUID()}.${extension}`;
  const {error}=await sbClient.storage.from(CATALOG_IMAGE_BUCKET)
    .upload(path,file,{contentType:file.type,upsert:false});
  if(error)throw error;
  return sbClient.storage.from(CATALOG_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

function managedCatalogImagePath(imageUrl){
  if(!imageUrl)return null;
  try{
    const url=new URL(imageUrl);
    const projectOrigin=new URL(SUPABASE_URL).origin;
    const marker=`/storage/v1/object/public/${CATALOG_IMAGE_BUCKET}/`;
    if(url.origin!==projectOrigin||!url.pathname.startsWith(marker))return null;
    return decodeURIComponent(url.pathname.slice(marker.length));
  }catch(e){return null;}
}

async function removeCatalogImage(imageUrl,preserveOrderHistory=false){
  try{
    const path=managedCatalogImagePath(imageUrl);
    if(!path)return true;
    const referenceQueries=[
      sbClient.from("categories").select("id").eq("image",imageUrl).limit(1),
      sbClient.from("products").select("id").eq("image",imageUrl).limit(1),
      sbClient.from("payment_methods").select("id").eq("image_url",imageUrl).limit(1),
      sbClient.from("store_banners").select("id").eq("image_url",imageUrl).limit(1),
    ];
    if(preserveOrderHistory){
      referenceQueries.push(sbClient.from("orders").select("id").eq("product_image",imageUrl).limit(1));
    }
    const references=await Promise.all(referenceQueries);
    const referenceError=references.find(result=>result.error)?.error;
    if(referenceError){console.error("Could not check catalog image references:",referenceError);return false;}
    if(references.some(result=>result.data.length))return true;
    const {error}=await sbClient.storage.from(CATALOG_IMAGE_BUCKET).remove([path]);
    if(error){console.error("Catalog image cleanup failed:",error);return false;}
    return true;
  }catch(e){
    console.error("Catalog image cleanup failed:",e);
    return false;
  }
}

// ============================
// LOAD
// ============================
async function loadAllData(){
  if(adminLoadPromise){
    adminLoadQueued=true;
    return adminLoadPromise;
  }
  adminLoadPromise=loadAllDataNow();
  return adminLoadPromise;
}

async function loadAllDataNow(){
  showLoading();
  try{
    const [profilesResult,productsResult,ordersResult,depositsResult,categoriesResult,ledgerResult,auditResult,paymentMethodsResult,bannersResult]=await Promise.all([
      sbClient.from("profiles").select("id,username,phone,balance_syp,balance_usd,vip_level,created_at").order("created_at",{ascending:false}),
      sbClient.from("products").select("*").order("created_at",{ascending:false}),
      sbClient.from("orders").select("*").order("created_at",{ascending:false}),
      sbClient.from("deposits").select("*").order("created_at",{ascending:false}),
      sbClient.from("categories").select("*").order("created_at",{ascending:true}),
      sbClient.from("financial_ledger").select("*").order("created_at",{ascending:false}).limit(200),
      sbClient.from("audit_logs").select("*").order("created_at",{ascending:false}).limit(200),
      sbClient.from("payment_methods").select("*").order("sort_order",{ascending:true}),
      sbClient.from("store_banners").select("*").order("sort_order",{ascending:true}),
    ]);
    const missingSettingsTables=[];
    let availablePaymentMethods=paymentMethodsResult.data;
    let availableBanners=bannersResult.data;
    if(paymentMethodsResult.error){
      if(isMissingAdminSettingsTable(paymentMethodsResult.error,"payment_methods")){
        availablePaymentMethods=[];
        missingSettingsTables.push("payment_methods");
      }else throw paymentMethodsResult.error;
    }
    if(bannersResult.error){
      if(isMissingAdminSettingsTable(bannersResult.error,"store_banners")){
        availableBanners=[];
        missingSettingsTables.push("store_banners");
      }else throw bannersResult.error;
    }
    for(const result of [profilesResult,productsResult,ordersResult,depositsResult,categoriesResult,ledgerResult,auditResult]){
      if(result.error)throw result.error;
    }
    if(missingSettingsTables.length&&!missingAdminSettingsWarningShown){
      missingAdminSettingsWarningShown=true;
      console.error("Admin settings tables are unavailable:",missingSettingsTables);
      showToast("تم تحميل بيانات الإدارة، لكن جداول الدفع والبانرات غير موجودة. شغّل ترحيل إعدادات المتجر في Supabase.","error");
    }else if(!missingSettingsTables.length){
      missingAdminSettingsWarningShown=false;
    }
    users=profilesResult.data;
    products=productsResult.data.map(p=>({...p,categoryId:p.category_id,infoFields:p.info_fields}));
    orders=ordersResult.data;
    deposits=await Promise.all(depositsResult.data.map(async d=>({...d,image_url:await signedReceipt(d.receipt_path)})));
    categoriesData=categoriesResult.data.map(c=>({...c,parentId:c.parent_id}));
    ledger=ledgerResult.data;
    auditLogs=auditResult.data;
    paymentMethods=availablePaymentMethods;
    storeBanners=availableBanners;
    await mzAdminLoad();
    updateStats(); renderCatTree(); renderProductsTable(); renderProductsCards();
    renderOrdersTable(); renderOrdersCards();
    renderDepositsTable(); renderDepositsCards();
    renderFinancialLedger();renderAuditLogs();
    renderUsersTable(); renderUsersCards();
    renderVipPage(); renderVipAdminLevels();
    renderPaymentMethods();renderStoreBanners();
  }catch(e){console.error("Admin data load failed:",e);showToast("فشل تحميل البيانات. تحقق من صلاحيات حساب المشرف واتصال Supabase.","error");}
  finally{
    hideLoading();
    adminLoadPromise=null;
    if(adminLoadQueued){
      adminLoadQueued=false;
      void loadAllData();
    }
  }
}

// ============================
// STATS
// ============================
function updateStats(){
  document.getElementById("statUsers").textContent=users.length;
  document.getElementById("statProducts").textContent=products.length;
  document.getElementById("statCats").textContent=categoriesData.length;
  document.getElementById("statOrders").textContent=orders.length;
  document.getElementById("statOrdersDone").textContent=orders.filter(o=>o.status==="completed").length;
  document.getElementById("statSales").textContent=orders.filter(o=>o.status==="completed").reduce((s,o)=>s+Number(o.price||0),0).toLocaleString()+" ل.س";
  document.getElementById("statDepsPending").textContent=deposits.filter(d=>d.status==="pending").length;
  document.getElementById("statVip").textContent=users.filter(u=>u.vip_level&&u.vip_level>0).length;
}

// ============================
// VIP PAGE
// ============================
function renderVipAdminLevels(){
  const list = document.getElementById("vipLevelsAdminList");
  list.innerHTML = VIP_LEVELS_ADMIN.map(v=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card2);margin-bottom:8px;">
      <div>
        ${vipBadgeAdmin(v.level)}
        <span style="font-size:13px;color:var(--text);margin-right:8px;font-weight:600;">${v.name}</span>
        <span style="font-size:12px;color:var(--muted);">— ${v.desc}</span>
      </div>
      <div style="font-size:15px;font-weight:800;color:${v.discount?'var(--gold)':'var(--muted)'};">${v.discount?v.discount+'%':'—'}</div>
    </div>`).join('');
}

function renderVipPage(){
  const tbody=document.getElementById("vipUsersTbody"); tbody.innerHTML="";
  if(!users.length){tbody.innerHTML='<tr><td colspan="4" class="text-muted text-xs" style="text-align:center;padding:20px;">لا يوجد مستخدمون.</td></tr>';return;}
  users.forEach(u=>{
    const level = Number(u.vip_level||0);
    const vipInfo = VIP_LEVELS_ADMIN.find(v=>v.level===level)||VIP_LEVELS_ADMIN[0];
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td style="font-weight:600;">${htmlEscape(u.username)}</td>
      <td>${vipBadgeAdmin(level)}</td>
      <td style="color:${vipInfo.discount?'var(--gold)':'var(--muted)'};">${vipInfo.discount?vipInfo.discount+'%':'بدون خصم'}</td>
      <td>
        <div class="vip-select-wrap">
          <select class="sel-sm" id="vipSel_${u.id}">
            ${VIP_LEVELS_ADMIN.map(v=>`<option value="${v.level}" ${v.level===level?'selected':''}>${v.name}</option>`).join('')}
          </select>
          <button class="btn btn-gold btn-sm" onclick="saveUserVip('${u.id}')">حفظ</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

async function saveUserVip(uid){
  const sel=document.getElementById("vipSel_"+uid);
  if(!sel) return;
  const newLevel=Number(sel.value);
  showLoading();
  try{
    const {error}=await sbClient.rpc("admin_set_vip",{p_user_id:uid,p_level:newLevel});
    if(error)throw error;
    const i=users.findIndex(u=>u.id===uid);
    if(i!==-1)users[i].vip_level=newLevel;
    renderVipPage(); renderUsersTable(); updateStats();
    const vipInfo=VIP_LEVELS_ADMIN.find(v=>v.level===newLevel);
    showToast(`✅ تم تحديث VIP للمستخدم ${users[i].username} إلى ${vipInfo?vipInfo.name:'VIP '+newLevel}`,"success");
  }catch(e){console.error("VIP update failed:",e);showToast("خطأ في تحديث VIP.","error");}
  finally{hideLoading();}
}

// ============================
// CATEGORIES
// ============================
function getCatName(id){const c=categoriesData.find(x=>x.id===id);return c?c.name:"";}
function populateCatParentSelect(excludeId=null){
  const sel=document.getElementById("catParent");
  sel.innerHTML='<option value="">— قسم جذري (بدون أب) —</option>';
  categoriesData.filter(c=>c.id!==excludeId).forEach(c=>{
    const indent=getDepth(c)>0?"— ":"";
    sel.innerHTML+=`<option value="${c.id}">${indent}${htmlEscape(getCatPath(c.id))}</option>`;
  });
}
function getDepth(cat,d=0){if(!cat.parentId)return d;const p=categoriesData.find(c=>c.id===cat.parentId);return p?getDepth(p,d+1):d;}
function getCatPath(id){const parts=[];let cur=id;while(cur){const c=categoriesData.find(x=>x.id===cur);if(c){parts.unshift(c.name);cur=c.parentId||null;}else break;}return parts.join(" › ");}

function renderCatTree(){
  const container=document.getElementById("catTreeContainer");
  container.innerHTML="";
  function renderLevel(parentId,indent){
    categoriesData.filter(c=>(c.parentId||null)===parentId).forEach(cat=>{
      const prodCount=products.filter(p=>p.categoryId===cat.id).length;
      const childCount=categoriesData.filter(c=>(c.parentId||null)===cat.id).length;
      const div=document.createElement("div");
      div.className="cat-tree-item"+(indent?" cat-indent":"");
      div.innerHTML=`
        ${cat.image?`<img class="cat-tree-img" src="${htmlEscape(cat.image)}" alt="" onerror="this.src=''">`:'<div class="cat-tree-img" style="display:flex;align-items:center;justify-content:center;font-size:18px;">🎮</div>'}
        <div style="flex:1;">
          <div class="cat-tree-name">${htmlEscape(cat.name)}</div>
          <div class="cat-tree-sub">${childCount?childCount+' قسم فرعي — ':''}${prodCount} منتج${cat.parentId?' | أب: '+htmlEscape(getCatName(cat.parentId)):' | جذري'}</div>
        </div>
        <div class="actions">
          <button class="btn btn-outline btn-sm" onclick="openEditCat('${cat.id}')">تعديل</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCat('${cat.id}')">حذف</button>
        </div>`;
      container.appendChild(div);
      renderLevel(cat.id,true);
    });
  }
  renderLevel(null,false);
  if(!categoriesData.length){container.innerHTML='<div class="text-muted text-xs" style="padding:16px;">لا توجد أقسام حتى الآن.</div>';}
}

function openNewCat(){
  document.getElementById("catModalTitle").textContent="قسم جديد";
  document.getElementById("catId").value="";
  document.getElementById("catName").value="";
  document.getElementById("catModalError").textContent="";
  resetCatalogImage("category");
  populateCatParentSelect();
  openModal("catModal");
}
function openEditCat(id){
  const c=categoriesData.find(x=>x.id===id); if(!c) return;
  document.getElementById("catModalTitle").textContent="تعديل قسم";
  document.getElementById("catId").value=c.id;
  document.getElementById("catName").value=c.name||"";
  document.getElementById("catModalError").textContent="";
  resetCatalogImage("category",c.image||null);
  populateCatParentSelect(id);
  document.getElementById("catParent").value=c.parentId||"";
  openModal("catModal");
}
async function saveCat(){
  const id=document.getElementById("catId").value;
  const name=document.getElementById("catName").value.trim();
  const parentId=document.getElementById("catParent").value||null;
  const imageState=catalogImageState.category;
  const oldImage=categoriesData.find(category=>category.id===id)?.image||null;
  const err=document.getElementById("catModalError"); err.textContent="";
  if(!name){err.textContent="يرجى إدخال اسم القسم.";return;}
  if(id&&parentId){
    let check=parentId;
    while(check){
      if(check===id){err.textContent="لا يمكن جعل القسم ابناً لنفسه.";return;}
      const pc=categoriesData.find(c=>c.id===check);
      check=pc?pc.parentId||null:null;
    }
  }
  showLoading();
  let uploadedImage=null,saved=false;
  try{
    let image=imageState.currentUrl;
    if(imageState.clear)image=null;
    else if(imageState.file){uploadedImage=await uploadCatalogImage("categories",imageState.file);image=uploadedImage;}
    const payload={name,parent_id:parentId,image};
    const result=id
      ?await sbClient.from("categories").update(payload).eq("id",id).select().single()
      :await sbClient.from("categories").insert(payload).select().single();
    if(result.error)throw result.error;
    saved=true;
    const category={...result.data,parentId:result.data.parent_id};
    const oldIndex=categoriesData.findIndex(c=>c.id===category.id);
    if(oldIndex===-1)categoriesData.push(category);else categoriesData[oldIndex]=category;
    closeModal("catModal");resetCatalogImage("category",image);renderCatTree();updateStats();
    const cleaned=oldImage&&oldImage!==image?await removeCatalogImage(oldImage):true;
    showToast(cleaned?"✅ تم حفظ القسم.":"تم حفظ القسم، لكن تعذر حذف الصورة القديمة من التخزين.",cleaned?"success":"error");
  }catch(e){
    console.error("Category save failed:",e);
    const cleaned=uploadedImage&&!saved?await removeCatalogImage(uploadedImage):true;
    err.textContent=cleaned
      ?"تعذر حفظ القسم أو رفع صورته. تحقق من الاتصال والصلاحيات ثم حاول مجدداً."
      :"تعذر حفظ القسم وفشل تنظيف الصورة المرفوعة؛ قد تبقى الصورة في التخزين.";
  }
  finally{hideLoading();}
}

async function deleteCat(id){
  const children=categoriesData.filter(c=>(c.parentId||null)===id);
  const prods=products.filter(p=>p.categoryId===id);
  if(children.length||prods.length){showToast(`❌ لا يمكن حذف هذا القسم: يحتوي على ${children.length} قسم فرعي و${prods.length} منتج.`,"error");return;}
  if(!confirm("تأكيد حذف هذا القسم؟")) return;
  const category=categoriesData.find(item=>item.id===id);
  showLoading();
  try{
    const {error}=await sbClient.from("categories").delete().eq("id",id);
    if(error)throw error;
    categoriesData=categoriesData.filter(c=>c.id!==id);
    renderCatTree();updateStats();
    const cleaned=await removeCatalogImage(category?.image);
    showToast(cleaned?"تم حذف القسم.":"حُذف القسم، لكن تعذر حذف صورته من التخزين.","success");
  }catch(e){console.error("Category delete failed:",e);showToast("تعذر حذف القسم.","error");}
  finally{hideLoading();}
}

// ============================
// PRODUCTS
// ============================
function populateProdCatSelect(){
  const sel=document.getElementById("productCategory"); sel.innerHTML='<option value="">اختر قسماً...</option>';
  categoriesData.forEach(c=>{sel.innerHTML+=`<option value="${c.id}">${htmlEscape(getCatPath(c.id))}</option>`;});
}

function renderProductsTable(){
  const tbody=document.getElementById("prodsTbody"); tbody.innerHTML="";
  if(!products.length){tbody.innerHTML='<tr><td colspan="6" class="text-muted text-xs" style="text-align:center;padding:20px;">لا توجد منتجات.</td></tr>';return;}
  products.forEach(p=>{
    const tr=document.createElement("tr");
    const fieldsCount=p.infoFields&&p.infoFields.length?p.infoFields.length:0;
    tr.innerHTML=`
      <td>${htmlEscape(p.name)}</td>
      <td>${Number(p.price).toLocaleString()} ل.س</td>
      <td>${p.price_usd?'$'+Number(p.price_usd).toFixed(2):'—'}</td>
      <td>${htmlEscape(getCatPath(p.categoryId))||'—'}</td>
      <td>${fieldsCount?`<span style="font-size:11px;color:var(--accent2);">${fieldsCount} حقل</span>`:'—'}</td>
      <td><div class="actions">
        <button class="btn btn-outline btn-sm" onclick="openEditProduct('${p.id}')">تعديل</button>
        <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')">حذف</button>
      </div></td>`;
    tbody.appendChild(tr);
  });
}

function renderProductsCards(){
  const container=document.getElementById("prodsCardList"); if(!container) return;
  if(!products.length){container.innerHTML='<div class="text-muted text-xs" style="padding:16px;text-align:center;">لا توجد منتجات.</div>';return;}
  container.innerHTML="";
  products.forEach(p=>{
    const fieldsCount=p.infoFields&&p.infoFields.length?p.infoFields.length:0;
    const card=document.createElement("div"); card.className="data-card";
    card.innerHTML=`
      <div class="data-card-header">
        <div style="display:flex;align-items:center;gap:8px;">
          ${p.image?`<img src="${htmlEscape(p.image)}" style="width:38px;height:38px;border-radius:8px;object-fit:cover;border:1px solid var(--border);" onerror="this.style.display='none'" />`:'<div style="width:38px;height:38px;border-radius:8px;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:18px;">🎮</div>'}
          <div class="data-card-title">${htmlEscape(p.name)}</div>
        </div>
      </div>
      <div class="data-card-body">
        <div class="data-card-row"><span class="data-card-label">السعر SYP</span><span class="data-card-val" style="color:var(--green);">${Number(p.price).toLocaleString()} ل.س</span></div>
        ${p.price_usd?`<div class="data-card-row"><span class="data-card-label">السعر USD</span><span class="data-card-val" style="color:var(--accent2);">$${Number(p.price_usd).toFixed(2)}</span></div>`:''}
        <div class="data-card-row"><span class="data-card-label">القسم</span><span class="data-card-val">${htmlEscape(getCatPath(p.categoryId))||'—'}</span></div>
        ${fieldsCount?`<div class="data-card-row"><span class="data-card-label">الحقول</span><span class="data-card-val" style="color:var(--accent2);">${fieldsCount} حقل</span></div>`:''}
      </div>
      <div class="data-card-actions">
        <button class="btn btn-outline btn-sm" style="flex:1;" onclick="openEditProduct('${p.id}')">✏️ تعديل</button>
        <button class="btn btn-danger btn-sm" style="flex:1;" onclick="deleteProduct('${p.id}')">🗑️ حذف</button>
      </div>`;
    container.appendChild(card);
  });
}

function openNewProduct(){
  document.getElementById("productModalTitle").textContent="منتج جديد";
  document.getElementById("productId").value="";
  document.getElementById("productName").value="";
  document.getElementById("productPrice").value="";
  document.getElementById("productPriceUSD").value="";
  document.getElementById("productModalError").textContent="";
  resetCatalogImage("product");
  document.getElementById("infoFieldsList").innerHTML="";
  populateProdCatSelect();
  openModal("productModal");
}
function addInfoField(field=null){
  const list=document.getElementById("infoFieldsList");
  const idx=list.children.length;
  const fid="if_"+Date.now()+"_"+idx;
  const div=document.createElement("div");
  div.style.cssText="display:grid;grid-template-columns:1fr 100px 28px;gap:6px;align-items:center;";
  div.dataset.fid=fid;
  div.innerHTML=`
    <input type="text" class="form-input" placeholder="اسم الحقل (مثال: ID الحساب)" value="${field?field.name:''}" data-role="fname" style="font-size:13px;padding:7px 10px;" />
    <select class="form-select" data-role="ftype" style="font-size:12px;padding:7px 8px;">
      <option value="text" ${(!field||field.type==='text')?'selected':''}>نص</option>
      <option value="number" ${field&&field.type==='number'?'selected':''}>رقم</option>
      <option value="url" ${field&&field.type==='url'?'selected':''}>رابط</option>
    </select>
    <button type="button" onclick="this.parentElement.remove()" style="background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:6px;width:28px;height:28px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;">×</button>`;
  list.appendChild(div);
}

function getInfoFields(){
  const list=document.getElementById("infoFieldsList");
  const fields=[];
  list.querySelectorAll("[data-fid]").forEach((div,i)=>{
    const name=div.querySelector("[data-role=fname]").value.trim();
    const type=div.querySelector("[data-role=ftype]").value;
    if(name) fields.push({id:"f"+i,name,type});
  });
  return fields;
}

function openEditProduct(id){
  const p=products.find(x=>x.id===id); if(!p) return;
  document.getElementById("productModalTitle").textContent="تعديل منتج";
  document.getElementById("productId").value=p.id;
  document.getElementById("productName").value=p.name||"";
  document.getElementById("productPrice").value=p.price||"";
  document.getElementById("productPriceUSD").value=p.price_usd||"";
  document.getElementById("productModalError").textContent="";
  resetCatalogImage("product",p.image||null);
  document.getElementById("infoFieldsList").innerHTML="";
  if(p.infoFields&&p.infoFields.length>0) p.infoFields.forEach(f=>addInfoField(f));
  populateProdCatSelect();
  document.getElementById("productCategory").value=p.categoryId||"";
  openModal("productModal");
}

async function saveProduct(){
  const id=document.getElementById("productId").value;
  const name=document.getElementById("productName").value.trim();
  const price=Number(document.getElementById("productPrice").value);
  const priceUSD=Number(document.getElementById("productPriceUSD").value||0);
  const categoryId=document.getElementById("productCategory").value;
  const imageState=catalogImageState.product;
  const oldImage=products.find(product=>product.id===id)?.image||null;
  const infoFields=getInfoFields();
  const err=document.getElementById("productModalError"); err.textContent="";
  if(!name||!price||!categoryId){err.textContent="يرجى إدخال الاسم والسعر (SYP) والقسم.";return;}
  showLoading();
  let uploadedImage=null,saved=false;
  try{
    let image=imageState.currentUrl||"";
    if(imageState.clear)image="";
    else if(imageState.file){uploadedImage=await uploadCatalogImage("products",imageState.file);image=uploadedImage;}
    const payload={name,price,price_usd:priceUSD||null,category_id:categoryId,image,info_fields:infoFields,is_active:true};
    const result=id
      ?await sbClient.from("products").update(payload).eq("id",id).select().single()
      :await sbClient.from("products").insert(payload).select().single();
    if(result.error)throw result.error;
    saved=true;
    const product={...result.data,categoryId:result.data.category_id,infoFields:result.data.info_fields};
    const oldIndex=products.findIndex(p=>p.id===product.id);
    if(oldIndex===-1)products.push(product);else products[oldIndex]=product;
    closeModal("productModal");resetCatalogImage("product",image||null);renderProductsTable();renderProductsCards();updateStats();
    const cleaned=oldImage&&oldImage!==image?await removeCatalogImage(oldImage,true):true;
    showToast(cleaned?"✅ تم حفظ المنتج.":"تم حفظ المنتج، لكن تعذر حذف الصورة القديمة من التخزين.",cleaned?"success":"error");
  }catch(e){
    console.error("Product save failed:",e);
    const cleaned=uploadedImage&&!saved?await removeCatalogImage(uploadedImage):true;
    err.textContent=cleaned
      ?"تعذر حفظ المنتج أو رفع صورته. تحقق من الاتصال والصلاحيات ثم حاول مجدداً."
      :"تعذر حفظ المنتج وفشل تنظيف الصورة المرفوعة؛ قد تبقى الصورة في التخزين.";
  }
  finally{hideLoading();}
}

async function deleteProduct(id){
  if(!confirm("تأكيد حذف المنتج؟")) return;
  const product=products.find(item=>item.id===id);
  showLoading();
  try{
    const {error}=await sbClient.from("products").delete().eq("id",id);
    if(error)throw error;
    products=products.filter(p=>p.id!==id);renderProductsTable();renderProductsCards();updateStats();
    const cleaned=await removeCatalogImage(product?.image,true);
    showToast(cleaned?"تم حذف المنتج.":"حُذف المنتج، لكن تعذر حذف صورته من التخزين.","success");
  }
  catch(e){console.error("Product delete failed:",e);showToast("خطأ في الحذف.","error");}
  finally{hideLoading();}
}

// ============================
// ORDERS
// ============================
function renderOrdersTable(){
  const tbody=document.getElementById("ordersTbody"); tbody.innerHTML="";
  if(!orders.length){tbody.innerHTML='<tr><td colspan="7" class="text-muted text-xs" style="text-align:center;padding:20px;">لا توجد طلبات.</td></tr>';return;}
  orders.slice().reverse().forEach(o=>{
    const cur=o.currency||"SYP"; const sym=cur==="USD"?"$":"ل.س";
    let infoHtml="—";
    if(o.info_data&&Object.keys(o.info_data).length>0){
      infoHtml=Object.entries(o.info_data).map(([k,v])=>`<div style="font-size:11px;"><b>${htmlEscape(k)}:</b> ${htmlEscape(v)}</div>`).join("");
    }
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td><div>${htmlEscape(o.username)}</div>${o.phone?`<div style="font-size:11px;color:var(--accent2);">📱 ${htmlEscape(o.phone)}</div>`:''}</td>
      <td>${htmlEscape(o.product_name)}</td>
      <td>${Number(o.price).toLocaleString()} ${sym}</td>
      <td>${badge(o.status)}</td>
      <td style="max-width:140px;">${infoHtml}</td>
      <td>${new Date(o.created_at).toLocaleString("ar-EG")}</td>
      <td><div class="actions">
        <select class="sel-sm" onchange="updateOrderStatus('${o.id}',this.value)">
          <option value="pending" ${o.status==='pending'?'selected':''}>⏳ معلق</option>
          <option value="processing" ${o.status==='processing'?'selected':''}>🔄 جاري</option>
          <option value="completed" ${o.status==='completed'?'selected':''}>✅ مكتمل</option>
          <option value="cancelled" ${o.status==='cancelled'?'selected':''}>❌ ملغي</option>
        </select>
      </div></td>`;
    tbody.appendChild(tr);
  });
}

async function updateOrderStatus(id,status){
  const previousStatus=orders.find(order=>order.id===id)?.status;
  showLoading();
  try{
    const {data,error}=await sbClient.rpc("admin_update_order_status",{p_order_id:id,p_status:status});
    if(error)throw error;
    const i=orders.findIndex(o=>o.id===id);
    if(i!==-1)orders[i]=data;
    if(previousStatus!==data.status)await notifyTelegram("order_status",id);
    renderOrdersTable();renderOrdersCards();updateStats();
    showToast("✅ تم تحديث الحالة.","success");
  }catch(e){console.error("Order update failed:",e);showToast("خطأ في تحديث الطلب.","error");await loadAllData();}
  finally{hideLoading();}
}

// ============================
// DEPOSITS
// ============================
function renderDepositsTable(){
  const tbody=document.getElementById("depsTbody"); tbody.innerHTML="";
  if(!deposits.length){tbody.innerHTML='<tr><td colspan="7" class="text-muted text-xs" style="text-align:center;padding:20px;">لا توجد إيداعات.</td></tr>';return;}
  deposits.slice().reverse().forEach(d=>{
    const cur=d.currency==="USD"?"USD":"SYP";
    const curTag=`<span class="cur-tag cur-${cur.toLowerCase()}">${cur}</span>`;
    const details=renderDepositPaymentDetails(d);
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td>${htmlEscape(d.username)}</td>
      <td>${Number(d.amount).toLocaleString()} ${curTag}</td>
      <td style="font-size:11px;color:var(--muted);">${htmlEscape(d.method||'—')}${details}</td>
      <td>${badge(d.status)}</td>
      <td>${d.image_url?`<a href="${d.image_url}" target="_blank" style="color:var(--accent);font-size:12px;">عرض الصورة</a>`:'—'}</td>
      <td>${new Date(d.created_at).toLocaleString("ar-EG")}</td>
      <td><div class="actions">
        ${d.status==='pending'?`<button class="btn btn-success btn-sm" onclick="handleDeposit('${d.id}','accept')">✅ قبول</button><button class="btn btn-danger btn-sm" onclick="handleDeposit('${d.id}','reject')">❌ رفض</button>`:'<span class="text-muted text-xs">تمت المعالجة</span>'}
      </div></td>`;
    tbody.appendChild(tr);
  });
}

function renderDepositPaymentDetails(deposit){
  const details=deposit.payment_details||{};
  if(!Object.keys(details).length)return "";
  const labels=Object.fromEntries((deposit.payment_fields||[]).map(field=>[field.key,field.label]));
  return `<div class="deposit-payment-details">${Object.entries(details)
    .map(([key,value])=>`<div><b>${htmlEscape(labels[key]||key)}:</b> ${htmlEscape(value)}</div>`).join("")}</div>`;
}

function renderFinancialLedger(){
  const tbody=document.getElementById("ledgerTbody");
  tbody.replaceChildren();
  if(!ledger.length){
    const row=tbody.insertRow();const cell=row.insertCell();cell.colSpan=6;cell.textContent="لا توجد حركات مالية.";
    return;
  }
  const labels={purchase:"شراء",deposit:"إيداع",refund:"استرداد",admin_adjustment:"تعديل إداري"};
  ledger.forEach(entry=>{
    const row=tbody.insertRow();
    const user=users.find(item=>item.id===entry.user_id);
    const cells=[
      user?.username||entry.user_id,
      labels[entry.transaction_type]||entry.transaction_type,
      `${Number(entry.amount).toLocaleString()} ${entry.currency==="USD"?"$":"ل.س"}`,
      `${Number(entry.balance_after).toLocaleString()} ${entry.currency==="USD"?"$":"ل.س"}`,
      entry.note||"—",
      new Date(entry.created_at).toLocaleString("ar-EG"),
    ];
    cells.forEach(value=>{row.insertCell().textContent=String(value);});
  });
}

function renderAuditLogs(){
  const tbody=document.getElementById("auditTbody");
  tbody.replaceChildren();
  if(!auditLogs.length){
    const row=tbody.insertRow();const cell=row.insertCell();cell.colSpan=5;cell.textContent="لا توجد أحداث تدقيق.";
    return;
  }
  auditLogs.forEach(entry=>{
    const row=tbody.insertRow();
    const actor=users.find(item=>item.id===entry.actor_id);
    [
      actor?.username||"—",
      entry.action,
      `${entry.entity_type} · ${entry.entity_id||"—"}`,
      JSON.stringify(entry.details),
      new Date(entry.created_at).toLocaleString("ar-EG"),
    ].forEach(value=>{row.insertCell().textContent=String(value);});
  });
}

async function handleDeposit(id,action){
  const dep=deposits.find(d=>d.id===id);
  if(!dep||dep.status!=='pending'){showToast("تمت معالجة هذا الإيداع مسبقاً.","error");return;}
  const cur=dep.currency==="USD"?"$":"ل.س";
  if(!confirm(`تأكيد ${action==='accept'?'قبول':'رفض'} إيداع ${dep.amount} ${cur} للمستخدم ${dep.username}؟`)) return;
  showLoading();
  try{
    const {data,error}=await sbClient.rpc("review_deposit",{
      p_deposit_id:id,p_decision:action==="accept"?"accept":"reject",
    });
    if(error)throw error;
    const di=deposits.findIndex(d=>d.id===id);
    if(di!==-1)deposits[di]={...data,image_url:dep.image_url};
    await notifyTelegram("deposit_review",id);
    const ui=users.findIndex(u=>u.id===dep.user_id);
    if(ui!==-1&&action==="accept"){
      const {data:updatedUser,error:userError}=await sbClient.from("profiles")
        .select("balance_syp,balance_usd").eq("id",dep.user_id).single();
      if(userError)throw userError;
      Object.assign(users[ui],updatedUser);
    }
    showToast(action==="accept"?"✅ تم قبول الإيداع وإضافة الرصيد.":"تم رفض الإيداع.","success");
    renderDepositsTable();renderDepositsCards();renderUsersTable();renderUsersCards();updateStats();
  }catch(e){console.error("Deposit review failed:",e);showToast("خطأ في معالجة الإيداع.","error");await loadAllData();}
  finally{hideLoading();}
}

function renderPaymentMethods(){
  const container=document.getElementById("paymentMethodsList");
  container.replaceChildren();
  if(!paymentMethods.length){container.innerHTML='<div class="settings-empty">لا توجد طرق دفع بعد. أضف طريقة ليتمكن العملاء من إرسال طلبات شحن.</div>';return;}
  paymentMethods.forEach(method=>{
    const card=document.createElement("article");
    card.className="settings-card";
    const image=method.image_url
      ?`<img class="settings-method-image" src="${htmlEscape(method.image_url)}" alt="">`
      :'<div class="settings-method-placeholder">💳</div>';
    const fields=(method.fields||[]).map(field=>htmlEscape(field.label)).join("، ")||"لا توجد حقول إضافية";
    card.innerHTML=`${image}<div class="settings-card-content">
      <div class="settings-card-title">${htmlEscape(method.name)} ${method.is_active?'<span class="settings-active">نشطة</span>':'<span class="settings-inactive">متوقفة</span>'}</div>
      <div class="settings-card-meta">${(method.currencies||[]).map(htmlEscape).join(" / ")}</div>
      <div class="settings-card-meta">${htmlEscape(method.description||"")} · ${fields}</div>
    </div><div class="settings-card-actions"></div>`;
    const actions=card.querySelector(".settings-card-actions");
    const edit=document.createElement("button");edit.className="btn btn-outline btn-sm";edit.textContent="تعديل";
    edit.onclick=()=>openPaymentMethod(method.id);
    const toggle=document.createElement("button");toggle.className="btn btn-outline btn-sm";toggle.textContent=method.is_active?"إيقاف":"تفعيل";
    toggle.onclick=()=>togglePaymentMethod(method.id,!method.is_active);
    const remove=document.createElement("button");remove.className="btn btn-danger btn-sm";remove.textContent="حذف";
    remove.onclick=()=>deletePaymentMethod(method.id);
    actions.append(edit,toggle,remove);
    container.appendChild(card);
  });
}

function resetPaymentMethodImage(url=null){
  if(paymentMethodImageObjectUrl){URL.revokeObjectURL(paymentMethodImageObjectUrl);paymentMethodImageObjectUrl=null;}
  paymentMethodImageUrl=url;
  const input=document.getElementById("paymentMethodImageFile");
  const preview=document.getElementById("paymentMethodImagePreview");
  const remove=document.getElementById("paymentMethodImageRemove");
  input.value="";
  if(url){preview.src=url;preview.hidden=false;remove.hidden=false;}
  else{preview.removeAttribute("src");preview.hidden=true;remove.hidden=true;}
  remove.textContent="إزالة الصورة";
}

function previewPaymentMethodImage(){
  const input=document.getElementById("paymentMethodImageFile"),file=input.files?.[0];
  if(!file)return;
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>CATALOG_IMAGE_MAX_BYTES){
    input.value="";showToast("اختر صورة JPG أو PNG أو WebP حتى 5 ميغابايت.","error");return;
  }
  if(paymentMethodImageObjectUrl)URL.revokeObjectURL(paymentMethodImageObjectUrl);
  paymentMethodImageObjectUrl=URL.createObjectURL(file);
  const preview=document.getElementById("paymentMethodImagePreview");
  preview.src=paymentMethodImageObjectUrl;preview.hidden=false;
  const remove=document.getElementById("paymentMethodImageRemove");
  remove.hidden=false;remove.textContent="إلغاء التغيير";
}

function clearPaymentMethodImage(){
  const fileInput=document.getElementById("paymentMethodImageFile");
  const remove=document.getElementById("paymentMethodImageRemove");
  if(fileInput.files?.length){
    resetPaymentMethodImage(paymentMethodImageUrl);
    return;
  }
  if(paymentMethodImageUrl){
    if(remove.textContent==="إلغاء إزالة الصورة"){
      resetPaymentMethodImage(paymentMethodImageUrl);
      return;
    }
    paymentMethodImageUrl=null;
    const preview=document.getElementById("paymentMethodImagePreview");
    preview.removeAttribute("src");preview.hidden=true;
    remove.textContent="إلغاء إزالة الصورة";
  }
}

function openPaymentMethod(id=null){
  const method=paymentMethods.find(item=>item.id===id);
  document.getElementById("paymentMethodModalTitle").textContent=method?"تعديل طريقة الدفع":"طريقة دفع جديدة";
  document.getElementById("paymentMethodId").value=method?.id||"";
  document.getElementById("paymentMethodName").value=method?.name||"";
  document.getElementById("paymentMethodDescription").value=method?.description||"";
  document.getElementById("paymentMethodInstructions").value=method?.instructions||"";
  document.getElementById("paymentMethodDestination").value=method?.destination||"";
  document.getElementById("paymentMethodCurrencies").querySelectorAll("input").forEach(input=>{
    input.checked=(method?.currencies||["SYP"]).includes(input.value);
  });
  document.getElementById("paymentMethodError").textContent="";
  const fields=document.getElementById("paymentFieldsList");fields.replaceChildren();
  (method?.fields||[]).forEach(field=>addPaymentField(field));
  resetPaymentMethodImage(method?.image_url||null);
  openModal("paymentMethodModal");
}

function addPaymentField(field={}){
  const row=document.createElement("div");row.className="payment-field-row";
  const key=field.key||`field_${crypto.randomUUID().replaceAll("-","").slice(0,12)}`;
  row.dataset.key=key;
  row.innerHTML=`<label>اسم الحقل<input class="form-input payment-field-label" maxlength="80" value="${htmlEscape(field.label||"")}" placeholder="مثال: رقم العملية"></label>
    <label>النوع<select class="form-select payment-field-type">
      <option value="text">نص</option><option value="number">رقم</option><option value="tel">هاتف</option><option value="email">بريد إلكتروني</option><option value="select">قائمة خيارات</option>
    </select></label>
    <label class="payment-field-options-label">الخيارات<textarea class="form-input payment-field-options-text setting-textarea" aria-label="خيارات الحقل" placeholder="خيار 1، خيار 2"></textarea><small>اكتب الخيارات مفصولة بفواصل</small></label>
    <label class="payment-field-required"><input type="checkbox" class="payment-field-required-input" ${field.required?"checked":""}> مطلوب</label>
    <button type="button" class="btn btn-danger btn-sm payment-field-delete" aria-label="حذف الحقل">×</button>`;
  const typeSelect=row.querySelector(".payment-field-type");
  typeSelect.value=field.type||"text";
  const optionsWrap=row.querySelector(".payment-field-options-label");
  optionsWrap.hidden=typeSelect.value!=="select";
  typeSelect.onchange=()=>{optionsWrap.hidden=typeSelect.value!=="select";};
  row.querySelector(".payment-field-options-text").value=(field.options||[]).join(", ");
  row.querySelector(".payment-field-delete").onclick=()=>row.remove();
  document.getElementById("paymentFieldsList").appendChild(row);
}

function readPaymentFields(){
  const rows=[...document.querySelectorAll(".payment-field-row")];
  if(rows.length>12)throw new Error("يمكن إضافة 12 حقلاً كحد أقصى.");
  return rows.map((row,index)=>{
    const label=row.querySelector(".payment-field-label").value.trim();
    const type=row.querySelector(".payment-field-type").value;
    if(!label)throw new Error(`أدخل اسم الحقل رقم ${index+1}.`);
    const field={key:row.dataset.key,label,type,required:row.querySelector(".payment-field-required-input").checked};
    if(type==="select"){
      field.options=[...new Set(row.querySelector(".payment-field-options-text").value.split(",").map(value=>value.trim()).filter(Boolean))];
      if(!field.options.length)throw new Error(`أدخل خيارات الحقل «${label}».`);
    }
    return field;
  });
}

async function savePaymentMethod(){
  const id=document.getElementById("paymentMethodId").value;
  const existing=paymentMethods.find(method=>method.id===id);
  const error=document.getElementById("paymentMethodError");
  error.textContent="";
  const currencies=[...document.querySelectorAll("#paymentMethodCurrencies input:checked")].map(input=>input.value);
  const name=document.getElementById("paymentMethodName").value.trim();
  if(!name||!currencies.length){error.textContent="أدخل اسم الطريقة وحدد عملة واحدة على الأقل.";return;}
  let fields;
  try{fields=readPaymentFields();}
  catch(e){error.textContent=e.message;return;}
  const input=document.getElementById("paymentMethodImageFile"),file=input.files?.[0];
  showLoading();
  let uploadedImage=null,saved=false;
  try{
    let imageUrl=paymentMethodImageUrl;
    if(document.getElementById("paymentMethodImageRemove").textContent==="إلغاء إزالة الصورة")imageUrl=null;
    if(file){uploadedImage=await uploadCatalogImage("payment-methods",file);imageUrl=uploadedImage;}
    const payload={
      name,description:document.getElementById("paymentMethodDescription").value.trim(),
      instructions:document.getElementById("paymentMethodInstructions").value.trim(),
      destination:document.getElementById("paymentMethodDestination").value.trim(),
      currencies,fields,image_url:imageUrl,is_active:existing?.is_active??true,sort_order:existing?.sort_order??paymentMethods.length,
    };
    const result=id
      ?await sbClient.from("payment_methods").update(payload).eq("id",id).select().single()
      :await sbClient.from("payment_methods").insert(payload).select().single();
    if(result.error)throw result.error;
    saved=true;
    paymentMethods=paymentMethods.filter(method=>method.id!==result.data.id).concat(result.data).sort((a,b)=>a.sort_order-b.sort_order);
    closeModal("paymentMethodModal");renderPaymentMethods();
    const cleaned=existing?.image_url&&existing.image_url!==imageUrl?await removeCatalogImage(existing.image_url):true;
    showToast(cleaned?"تم حفظ طريقة الدفع.":"حُفظت الطريقة لكن تعذر حذف صورتها القديمة.",cleaned?"success":"error");
  }catch(e){
    console.error("Payment method save failed:",e);
    const cleaned=uploadedImage&&!saved?await removeCatalogImage(uploadedImage):true;
    error.textContent=cleaned?"تعذر حفظ طريقة الدفع. تحقق من الاتصال والصلاحيات.":"تعذر الحفظ وفشل تنظيف الصورة المرفوعة.";
  }finally{hideLoading();}
}

async function togglePaymentMethod(id,isActive){
  const {error}=await sbClient.from("payment_methods").update({is_active:isActive}).eq("id",id);
  if(error){console.error("Payment method status update failed:",error);showToast("تعذر تحديث الطريقة.","error");return;}
  const method=paymentMethods.find(item=>item.id===id);if(method)method.is_active=isActive;
  renderPaymentMethods();showToast(isActive?"تم تفعيل طريقة الدفع.":"تم إيقاف طريقة الدفع.","success");
}

async function deletePaymentMethod(id){
  const method=paymentMethods.find(item=>item.id===id);if(!method)return;
  if(!confirm(`حذف طريقة الدفع «${method.name}»؟ ستبقى طلبات الشحن السابقة محفوظة.`))return;
  const {error}=await sbClient.from("payment_methods").delete().eq("id",id);
  if(error){console.error("Payment method deletion failed:",error);showToast("تعذر حذف طريقة الدفع.","error");return;}
  paymentMethods=paymentMethods.filter(item=>item.id!==id);renderPaymentMethods();
  const cleaned=await removeCatalogImage(method.image_url);
  showToast(cleaned?"تم حذف طريقة الدفع.":"حُذفت الطريقة لكن تعذر حذف صورتها من التخزين.",cleaned?"success":"error");
}

function previewBannerUpload(){
  const file=document.getElementById("bannerImageFile").files?.[0];
  const preview=document.getElementById("bannerImagePreview");
  if(bannerImageObjectUrl){URL.revokeObjectURL(bannerImageObjectUrl);bannerImageObjectUrl=null;}
  if(!file){preview.hidden=true;return;}
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>CATALOG_IMAGE_MAX_BYTES){
    document.getElementById("bannerImageFile").value="";preview.hidden=true;
    document.getElementById("bannerError").textContent="اختر JPG أو PNG أو WebP حتى 5 ميغابايت.";
    return;
  }
  document.getElementById("bannerError").textContent="";
  bannerImageObjectUrl=URL.createObjectURL(file);preview.src=bannerImageObjectUrl;preview.hidden=false;
}

function renderStoreBanners(){
  const container=document.getElementById("storeBannersList");container.replaceChildren();
  if(!storeBanners.length){container.innerHTML='<div class="settings-empty">لا توجد بانرات مضافة. ارفع أول صورة لتظهر في أعلى المتجر.</div>';return;}
  storeBanners.forEach(banner=>{
    const card=document.createElement("article");card.className="banner-admin-card";
    card.innerHTML=`<img src="${htmlEscape(banner.image_url)}" alt="${htmlEscape(banner.alt_text||"")}">
      <div class="banner-admin-info"><strong>${htmlEscape(banner.alt_text||"بانر")}</strong><small>${banner.href?htmlEscape(banner.href):"بدون رابط"}</small></div>`;
    const remove=document.createElement("button");remove.className="btn btn-danger btn-sm";remove.textContent="حذف";
    remove.onclick=()=>deleteStoreBanner(banner.id);
    card.appendChild(remove);container.appendChild(card);
  });
}

async function addStoreBanner(){
  if(paymentBannerSaving)return;
  const file=document.getElementById("bannerImageFile").files?.[0];
  const error=document.getElementById("bannerError");error.textContent="";
  if(!file){error.textContent="اختر صورة للبانر.";return;}
  let href=document.getElementById("bannerHref").value.trim();
  if(href){
    try{const url=new URL(href);if(!["http:","https:"].includes(url.protocol))throw new Error();}
    catch(e){error.textContent="أدخل رابطاً صحيحاً يبدأ بـ https:// أو http://.";return;}
  }
  paymentBannerSaving=true;showLoading();
  let uploadedImage=null,saved=false;
  try{
    uploadedImage=await uploadCatalogImage("banners",file);
    const result=await sbClient.from("store_banners").insert({
      image_url:uploadedImage,alt_text:document.getElementById("bannerAltText").value.trim(),
      href:href||null,sort_order:storeBanners.length,is_active:true,
    }).select().single();
    if(result.error)throw result.error;
    saved=true;storeBanners.push(result.data);renderStoreBanners();renderBanners(storeBanners);
    document.getElementById("bannerImageFile").value="";
    document.getElementById("bannerAltText").value="";
    document.getElementById("bannerHref").value="";
    document.getElementById("bannerImagePreview").hidden=true;
    if(bannerImageObjectUrl){URL.revokeObjectURL(bannerImageObjectUrl);bannerImageObjectUrl=null;}
    showToast("تم رفع وإضافة البانر.","success");
  }catch(e){
    console.error("Store banner upload failed:",e);
    const cleaned=uploadedImage&&!saved?await removeCatalogImage(uploadedImage):true;
    error.textContent=cleaned?"تعذر إضافة البانر. تحقق من الاتصال والصلاحيات.":"تعذرت الإضافة وفشل تنظيف الصورة المرفوعة.";
  }finally{paymentBannerSaving=false;hideLoading();}
}

async function deleteStoreBanner(id){
  const banner=storeBanners.find(item=>item.id===id);if(!banner)return;
  if(!confirm("حذف هذا البانر من المتجر؟"))return;
  const {error}=await sbClient.from("store_banners").delete().eq("id",id);
  if(error){console.error("Store banner deletion failed:",error);showToast("تعذر حذف البانر.","error");return;}
  storeBanners=storeBanners.filter(item=>item.id!==id);renderStoreBanners();renderBanners(storeBanners);
  const cleaned=await removeCatalogImage(banner.image_url);
  showToast(cleaned?"تم حذف البانر.":"حُذف البانر لكن تعذر حذف الصورة من التخزين.",cleaned?"success":"error");
}

// ============================
// USERS
// ============================
function renderUsersTable(){
  const tbody=document.getElementById("usersTbody"); tbody.innerHTML="";
  if(!users.length){tbody.innerHTML='<tr><td colspan="6" class="text-muted text-xs" style="text-align:center;padding:20px;">لا يوجد مستخدمون.</td></tr>';return;}
  users.forEach(u=>{
    const balSYP=Number(u.balance_syp||u.balance||0);
    const balUSD=Number(u.balance_usd||0);
    const vipLevel=Number(u.vip_level||0);
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td style="font-weight:600;">${htmlEscape(u.username)}</td>
      <td style="font-size:12px;color:var(--accent2);">${u.phone?htmlEscape(u.phone):'<span class="text-muted">—</span>'}</td>
      <td>
        <div class="bal-dual">
          <div class="bal-syp-val">${balSYP.toLocaleString()} ل.س</div>
          <div class="bal-usd-val">$${balUSD.toFixed(2)} USD</div>
        </div>
      </td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="openEditBal('${u.id}')">✏️ تعديل</button>
      </td>
      <td>
        <div class="vip-select-wrap">
          ${vipBadgeAdmin(vipLevel)}
        </div>
      </td>
      <td>${new Date(u.created_at||0).toLocaleDateString("ar-EG")}</td>`;
    tbody.appendChild(tr);
  });
}

function openEditBal(uid){
  const u=users.find(x=>x.id===uid); if(!u) return;
  document.getElementById("editBalUid").value=uid;
  document.getElementById("editBalUsername").textContent="المستخدم: "+u.username;
  document.getElementById("editBalSYP").value=Number(u.balance_syp||u.balance||0);
  document.getElementById("editBalUSD").value=Number(u.balance_usd||0);
  document.getElementById("editBalError").textContent="";
  document.getElementById("editBalNote").value="";
  openModal("editBalModal");
}

async function saveUserBalance(){
  const uid=document.getElementById("editBalUid").value;
  const valSYP=Number(document.getElementById("editBalSYP").value||0);
  const valUSD=Number(document.getElementById("editBalUSD").value||0);
  const note=document.getElementById("editBalNote").value.trim();
  const err=document.getElementById("editBalError");
  if(!note){err.textContent="أدخل سبب تعديل الرصيد لتسجيله في سجل التدقيق.";return;}
  showLoading();
  try{
    const i=users.findIndex(u=>u.id===uid);
    if(i===-1) return;
    const {data,error}=await sbClient.rpc("admin_set_balances",{
      p_user_id:uid,p_target_syp:valSYP,p_target_usd:valUSD,p_note:note,
    });
    if(error)throw error;
    users[i].balance_syp=data.balance_syp;
    users[i].balance_usd=data.balance_usd;
    closeModal("editBalModal");
    renderUsersTable();updateStats();showToast("✅ تم تحديث الرصيد.","success");
  }catch(e){console.error("Balance adjustment failed:",e);showToast("خطأ في تحديث الرصيد.","error");await loadAllData();}
  finally{hideLoading();}
}


// ============================
// MOBILE CARD RENDERERS
// ============================
function renderOrdersCards(){
  const container=document.getElementById("ordersCardList"); if(!container) return;
  if(!orders.length){container.innerHTML='<div class="text-muted text-xs" style="padding:16px;text-align:center;">لا توجد طلبات.</div>';return;}
  container.innerHTML="";
  orders.slice().reverse().forEach(o=>{
    const cur=o.currency||"SYP"; const sym=cur==="USD"?"$":"ل.س";
    let infoHtml="";
    if(o.info_data&&Object.keys(o.info_data).length>0){
      infoHtml=Object.entries(o.info_data).map(([k,v])=>`<div class="data-card-row"><span class="data-card-label">${htmlEscape(k)}</span><span class="data-card-val" style="color:var(--accent2);font-size:11px;">${htmlEscape(v)}</span></div>`).join("");
    }
    const card=document.createElement("div"); card.className="data-card";
    card.innerHTML=`
      <div class="data-card-header">
        <div class="data-card-title">🎮 ${htmlEscape(o.product_name)}</div>
        ${badge(o.status)}
      </div>
      <div class="data-card-body">
        <div class="data-card-row"><span class="data-card-label">المستخدم</span><span class="data-card-val">${htmlEscape(o.username)}${o.phone?` <span style="color:var(--accent2);font-size:10px;">📱${htmlEscape(o.phone)}</span>`:''}</span></div>
        <div class="data-card-row"><span class="data-card-label">السعر</span><span class="data-card-val" style="color:var(--green);">${Number(o.price).toLocaleString()} ${sym}</span></div>
        <div class="data-card-row"><span class="data-card-label">التاريخ</span><span class="data-card-val">${new Date(o.created_at).toLocaleDateString("ar-EG")}</span></div>
        ${infoHtml}
      </div>
      <div class="data-card-actions">
        <select class="sel-sm" onchange="updateOrderStatus('${o.id}',this.value)" style="flex:1;">
          <option value="pending" ${o.status==='pending'?'selected':''}>⏳ معلق</option>
          <option value="processing" ${o.status==='processing'?'selected':''}>🔄 جاري</option>
          <option value="completed" ${o.status==='completed'?'selected':''}>✅ مكتمل</option>
          <option value="cancelled" ${o.status==='cancelled'?'selected':''}>❌ ملغي</option>
        </select>
      </div>`;
    container.appendChild(card);
  });
}

function renderDepositsCards(){
  const container=document.getElementById("depsCardList"); if(!container) return;
  if(!deposits.length){container.innerHTML='<div class="text-muted text-xs" style="padding:16px;text-align:center;">لا توجد إيداعات.</div>';return;}
  container.innerHTML="";
  deposits.slice().reverse().forEach(d=>{
    const cur=d.currency==="USD"?"USD":"SYP";
    const curTag=`<span class="cur-tag cur-${cur.toLowerCase()}">${cur}</span>`;
    const card=document.createElement("div"); card.className="data-card";
    card.innerHTML=`
      <div class="data-card-header">
        <div class="data-card-title">💳 ${htmlEscape(d.username)}</div>
        ${badge(d.status)}
      </div>
      <div class="data-card-body">
        <div class="data-card-row"><span class="data-card-label">المبلغ</span><span class="data-card-val" style="color:var(--green);">${Number(d.amount).toLocaleString()} ${curTag}</span></div>
        <div class="data-card-row"><span class="data-card-label">الوسيلة</span><span class="data-card-val">${htmlEscape(d.method||'—')}</span></div>
        ${renderDepositPaymentDetails(d)}
        <div class="data-card-row"><span class="data-card-label">التاريخ</span><span class="data-card-val">${new Date(d.created_at).toLocaleDateString("ar-EG")}</span></div>
        ${d.image_url?`<div class="data-card-row"><span class="data-card-label">الصورة</span><a href="${d.image_url}" target="_blank" style="color:var(--accent);font-size:12px;">عرض</a></div>`:''}
      </div>
      ${d.status==='pending'?`<div class="data-card-actions">
        <button class="btn btn-success btn-sm" style="flex:1;" onclick="handleDeposit('${d.id}','accept')">✅ قبول</button>
        <button class="btn btn-danger btn-sm" style="flex:1;" onclick="handleDeposit('${d.id}','reject')">❌ رفض</button>
      </div>`:''}`;
    container.appendChild(card);
  });
}

function renderUsersCards(){
  const container=document.getElementById("usersCardList"); if(!container) return;
  if(!users.length){container.innerHTML='<div class="text-muted text-xs" style="padding:16px;text-align:center;">لا يوجد مستخدمون.</div>';return;}
  container.innerHTML="";
  users.forEach(u=>{
    const balSYP=Number(u.balance_syp||u.balance||0);
    const balUSD=Number(u.balance_usd||0);
    const vipLevel=Number(u.vip_level||0);
    const card=document.createElement("div"); card.className="data-card";
    card.innerHTML=`
      <div class="data-card-header">
        <div class="data-card-title">👤 ${htmlEscape(u.username)}</div>
        ${vipBadgeAdmin(vipLevel)}
      </div>
      <div class="data-card-body">
        ${u.phone?`<div class="data-card-row"><span class="data-card-label">الهاتف</span><span class="data-card-val" style="color:var(--accent2);">📱 ${htmlEscape(u.phone)}</span></div>`:''}
        <div class="data-card-row"><span class="data-card-label">الرصيد SYP</span><span class="data-card-val" style="color:var(--green);">${balSYP.toLocaleString()} ل.س</span></div>
        <div class="data-card-row"><span class="data-card-label">الرصيد USD</span><span class="data-card-val" style="color:var(--accent2);">$${balUSD.toFixed(2)}</span></div>
        <div class="data-card-row"><span class="data-card-label">تاريخ الانضمام</span><span class="data-card-val">${new Date(u.created_at||0).toLocaleDateString("ar-EG")}</span></div>
      </div>
      <div class="data-card-actions">
        <button class="btn btn-outline btn-sm" style="flex:1;" onclick="openEditBal('${u.id}')">✏️ تعديل الرصيد</button>
        <div style="display:flex;gap:6px;align-items:center;flex:1;">
          <select class="sel-sm" id="vipSel_card_${u.id}" style="flex:1;">
            ${VIP_LEVELS_ADMIN.map(v=>`<option value="${v.level}" ${v.level===vipLevel?'selected':''}>${v.name}</option>`).join('')}
          </select>
          <button class="btn btn-gold btn-sm" onclick="saveUserVip_card('${u.id}')">VIP</button>
        </div>
      </div>`;
    container.appendChild(card);
  });
}

async function saveUserVip_card(uid){
  const sel=document.getElementById("vipSel_card_"+uid); if(!sel) return;
  const newLevel=Number(sel.value);
  showLoading();
  try{
    const {error}=await sbClient.rpc("admin_set_vip",{p_user_id:uid,p_level:newLevel});
    if(error)throw error;
    const i=users.findIndex(u=>u.id===uid); if(i!==-1)users[i].vip_level=newLevel;
    renderUsersCards(); renderUsersTable(); updateStats();
    showToast("✅ تم تحديث VIP","success");
  }catch(e){console.error("VIP update failed:",e);showToast("خطأ.","error");}
  finally{hideLoading();}
}

// ============================
// NAVIGATION
// ============================
const pageTitles={dashboard:"📊 الإحصائيات",categories:"📁 الأقسام",products:"🎮 المنتجات",orders:"🛒 الطلبات",deposits:"💳 الإيداعات",payments:"💰 طرق الدفع",banners:"🖼️ البانرات",users:"👥 المستخدمون",vip:"👑 VIP",mosaic:"🧩 الفسيفساء"};

function switchPage(name){
  ['Dashboard','Categories','Products','Orders','Deposits','Payments','Banners','Users','Vip','Mosaic'].forEach(p=>{
    document.getElementById("page"+p).style.display=name===p.toLowerCase()?'block':'none';
  });
  document.querySelectorAll(".nav-btn[data-page]").forEach(b=>{
    b.classList.toggle("active",b.getAttribute("data-page")===name);
  });
  // Update mobile title
  const mTitle=document.getElementById("mobilePageTitle");
  if(mTitle) mTitle.textContent=pageTitles[name]||"";
  // Render card lists on mobile
  if(name==="orders") renderOrdersCards();
  if(name==="deposits") renderDepositsCards();
  if(name==="users") renderUsersCards();
  if(name==="products") renderProductsCards();
  if(name==="mosaic") mzEdOpen();
  // Close sidebar on mobile
  closeMobileSidebar();
}

function openMobileSidebar(){
  document.getElementById("adminSidebar").classList.add("open");
  document.getElementById("sidebarOverlay").classList.add("open");
}
function closeMobileSidebar(){
  document.getElementById("adminSidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("open");
}

// ============================
// EVENTS
// ============================
document.getElementById("btnMobileMenu").onclick=openMobileSidebar;
document.getElementById("sidebarOverlay").onclick=closeMobileSidebar;

document.getElementById("btnAdminLogin").onclick=()=>{
  const email=document.getElementById("adminEmail").value.trim();
  const p=document.getElementById("adminPass").value;
  const err=document.getElementById("adminLoginError"); err.textContent="";
  if(!email||!p){err.textContent="يرجى إدخال البريد الإلكتروني وكلمة المرور.";return;}
  (async()=>{
    showLoading();
    try{
      const {data,error}=await sbClient.auth.signInWithPassword({email,password:p});
      if(error)throw error;
      await activateAdmin(data.user.id);
    }catch(e){console.error("Admin login failed:",e);err.textContent="تعذر تسجيل الدخول. تحقق من بيانات المشرف وتأكيد البريد.";}
    finally{hideLoading();}
  })();
};
document.getElementById("adminPass").onkeyup=e=>{if(e.key==="Enter")document.getElementById("btnAdminLogin").click();};
document.getElementById("btnAdminLogout").onclick=async()=>{
  const {error}=await sbClient.auth.signOut();
  if(error){console.error("Admin sign out failed:",error);showToast("تعذر تسجيل الخروج.","error");return;}
  stopAdminRealtime();
  adminProfile=null;
  document.getElementById("adminView").style.display="none";
  document.getElementById("loginView").style.display="flex";
};
document.querySelectorAll(".nav-btn[data-page]").forEach(b=>b.onclick=()=>switchPage(b.getAttribute("data-page")));
document.querySelectorAll(".modal-close,[data-modal]").forEach(b=>{
  b.onclick=()=>{const id=b.getAttribute("data-modal")||b.getAttribute("data-close-modal");if(id)closeModal(id);};
});
document.getElementById("btnNewCat").onclick=openNewCat;
document.getElementById("btnSaveCat").onclick=saveCat;
document.getElementById("btnNewProduct").onclick=openNewProduct;
document.getElementById("btnSaveProduct").onclick=saveProduct;
document.getElementById("btnSaveBal").onclick=saveUserBalance;
document.getElementById("btnNewPaymentMethod").onclick=()=>openPaymentMethod();
document.getElementById("btnAddPaymentField").onclick=()=>addPaymentField();
document.getElementById("btnSavePaymentMethod").onclick=savePaymentMethod;
document.getElementById("btnAddBanner").onclick=addStoreBanner;
document.getElementById("bannerImageFile").onchange=previewBannerUpload;
document.getElementById("paymentMethodImageFile").onchange=previewPaymentMethodImage;
document.getElementById("paymentMethodImageRemove").onclick=clearPaymentMethodImage;

async function activateAdmin(userId){
  const {data,error}=await sbClient.from("profiles").select("id,username,role").eq("id",userId).single();
  if(error)throw error;
  if(data.role!=="admin"){
    await sbClient.auth.signOut();
    throw new Error("This account is not an administrator.");
  }
  adminProfile=data;
  document.getElementById("loginView").style.display="none";
  document.getElementById("adminView").style.display="block";
  await loadAllData();
  startAdminRealtime();
}

function startAdminRealtime(){
  if(adminRealtimeChannel){sbClient.removeChannel(adminRealtimeChannel);adminRealtimeChannel=null;}
  let channel=sbClient.channel("admin-live-updates");
  const tables=[
    "profiles","categories","products","mosaic_layouts","orders","deposits",
    "financial_ledger","audit_logs","payment_methods","store_banners",
  ];
  for(const table of tables){
    channel=channel.on("postgres_changes",{event:"*",schema:"public",table},()=>{
      clearTimeout(adminRealtimeTimer);
      adminRealtimeTimer=setTimeout(()=>loadAllData(),200);
    });
  }
  adminRealtimeChannel=channel.subscribe((status,error)=>{
    if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"){
      console.error("Admin realtime connection failed:",error||status);
      showToast("انقطع التحديث الفوري؛ تحقق من إعداد Realtime واتصال Supabase.","error");
    }
  });
}

function stopAdminRealtime(){
  clearTimeout(adminRealtimeTimer);
  if(adminRealtimeChannel){sbClient.removeChannel(adminRealtimeChannel);adminRealtimeChannel=null;}
}

(async()=>{
  const {data,error}=await sbClient.auth.getSession();
  if(error){console.error("Admin session restore failed:",error);return;}
  if(data.session){
    try{await activateAdmin(data.session.user.id);}
    catch(e){console.error("Admin session rejected:",e);showToast("الحساب لا يملك صلاحية المشرف.","error");}
  }
})();

// ============================
// محرّر الفسيفساء — MOSAIC DESIGNER
// القالب = {S: دقة الشبكة, boxes:[[عمود,صف,عرض,ارتفاع,قسم_مثبّت?],...]}
// الأعمدة تُعدّ من اليمين (نفس اتجاه المتجر RTL) والصفوف من الأعلى.
// ============================
const MZ_GRAD=[['#1e3a8a','#3b82f6'],['#3b0764','#7c3aed'],['#0c4a6e','#06b6d4'],['#312e81','#6366f1'],['#4c1d95','#a855f7'],['#164e63','#22d3ee'],['#1e1b4b','#4f46e5'],['#581c87','#c026d3']];
let mzL={};
const mzE={N:6,S:8,boxes:[],sel:-1,hist:[],circ:false,drag:null,ready:false};
const mzTouchesCircle=(c,r,S)=>{
  const dx=Math.max(Math.abs(c+.5-S/2)-.5,0);
  const dy=Math.max(Math.abs(r+.5-S/2)-.5,0);
  return dx*dx+dy*dy<=(S/2)*(S/2);
};
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
function mzAuto(N,S){return mzPack(N,S);}
const mzDefaultS=N=>N>=14?10:N>=6?8:6;
// نفس منطق المتجر لحساب عدد المربعات الحالي: أقسام رئيسية، وننزل للألعاب إن كانت أقل من 6
function mzStoreN(){
  let items=categoriesData.filter(c=>!c.parentId);
  for(let k=0;k<3&&items.length<6;k++){
    const ex=[];items.forEach(n=>{const ch=categoriesData.filter(c=>c.parentId===n.id);ex.push(...(ch.length?ch:[n]));});
    if(ex.length===items.length&&ex.every((n,i)=>n.id===items[i].id))break;
    items=ex;
  }
  return Math.min(items.length,23);
}
async function mzAdminLoad(){
  const {data,error}=await sbClient.from("mosaic_layouts").select("category_count,grid_size,boxes");
  if(error)throw error;
  mzL=Object.fromEntries(data.map(row=>[row.category_count,{S:row.grid_size,boxes:row.boxes}]));
}
function mzEdOpen(){
  if(!mzE.ready){mzEdInit();mzE.ready=true;}
  const n=mzStoreN();
  document.getElementById("mzedBinWarn").style.display="none";
  document.getElementById("mzedInfo").innerHTML=`عدد المربعات في متجرك الآن: <b>${n}</b>. صمّم القالب لهذا العدد وسيظهر في المتجر فوراً (قد يتأخر حتى 10 دقائق بسبب الكاش). يمكنك أيضاً تصميم قوالب لأعداد أخرى تحسّباً لإضافة ألعاب جديدة.`;
  if(mzE.boxes.length===0||!mzE.touched)mzEdLoad(n>=3?n:6);
  else mzEdSync();
}
function mzEdLoad(N){
  mzE.N=N;const sv=mzL[N];
  if(sv&&Array.isArray(sv.boxes)){mzE.S=+sv.S;mzE.boxes=sv.boxes.map(b=>[+b[0],+b[1],+b[2],+b[3],b[4]||null]);}
  else{mzE.S=mzDefaultS(N);const a=mzAuto(N,mzE.S);mzE.boxes=a?a.map(b=>[b[0],b[1],b[2],b[3],null]):[];}
  mzE.sel=-1;mzE.hist=[];mzE.touched=false;mzEdSync();
}
function mzEdSync(){
  document.getElementById("mzedN").value=mzE.N;
  document.getElementById("mzedS").value=String(mzE.S);
  document.getElementById("mzedCanvas").classList.toggle("circ",mzE.circ);
  const sv=document.getElementById("mzedSaved");
  const keys=Object.keys(mzL).map(Number).sort((a,b)=>a-b);
  sv.innerHTML=(keys.length?"قوالب مخصصة محفوظة: ":"لا توجد قوالب مخصصة بعد — المتجر يستخدم التوزيع التلقائي. ")+keys.map(k=>`<button class="mzed-chip${k===mzE.N?' on':''}" data-n="${k}">${k} ✓</button>`).join("");
  sv.querySelectorAll("[data-n]").forEach(b=>b.onclick=()=>mzEdLoad(+b.dataset.n));
  document.getElementById("mzedExport").value="const MZ_CUSTOM = "+JSON.stringify(mzL)+";";
  mzEdRender();
}
function mzCoverage(){
  const {S,boxes}=mzE;const own=Array.from({length:S},()=>Array(S).fill(-1));
  boxes.forEach((b,i)=>{for(let y=b[1];y<b[1]+b[3];y++)for(let x=b[0];x<b[0]+b[2];x++)if(y>=0&&y<S&&x>=0&&x<S)own[y][x]=i;});
  let unc=0;for(let r=0;r<S;r++)for(let c=0;c<S;c++)if(mzTouchesCircle(c,r,S)&&own[r][c]<0)unc++;
  return {own,unc};
}
function mzEdRender(){
  const {S,boxes,N}=mzE;const {own,unc}=mzCoverage();
  const cells=document.getElementById("mzedCells");
  cells.style.gridTemplate=`repeat(${S},1fr)/repeat(${S},1fr)`;
  let ch="";for(let r=0;r<S;r++)for(let c=0;c<S;c++){const inn=mzTouchesCircle(c,r,S);ch+=`<i class="${inn?(own[r][c]<0?'in unc':'in'):'out'}"></i>`;}
  cells.innerHTML=ch;
  const order=boxes.map((b,i)=>({i,a:b[2]*b[3],d:Math.hypot(b[0]+b[2]/2-S/2,b[1]+b[3]/2-S/2)})).sort((x,y)=>y.a-x.a||x.d-y.d);
  const rank={};order.forEach((o,k)=>rank[o.i]=k+1);
  const cs=100/S;
  document.getElementById("mzedTiles").innerHTML=boxes.map((b,i)=>{
    const gp=MZ_GRAD[i%MZ_GRAD.length];
    const pin=b[4]?categoriesData.find(x=>x.id===b[4]):null;
    const lbl=b[2]*b[3]>=2?`<span class="tl">${pin?pin.name:"#"+rank[i]}<small>${pin?"مثبّت":b[2]+"×"+b[3]}</small></span>`:`<span class="tl" style="padding:0">${pin?"📌":rank[i]}</span>`;
    return `<div class="mzed-tile${i===mzE.sel?' sel':''}" data-i="${i}" style="right:${b[0]*cs}%;top:${b[1]*cs}%;width:${b[2]*cs}%;height:${b[3]*cs}%;background:linear-gradient(145deg,${gp[0]},${gp[1]})">${lbl}<button class="mzed-x" title="حذف">×</button><span class="mzed-rz"></span></div>`;
  }).join("");
  const valid=boxes.length===N&&unc===0;
  const cnt=document.getElementById("mzedCount");cnt.textContent=boxes.length+" / "+N;cnt.className=boxes.length===N?"ok":"no";
  const u=document.getElementById("mzedUnc");u.textContent=unc;u.className=unc===0?"ok":"no";
  const st=document.getElementById("mzedState");st.textContent=valid?"✓ جاهز للحفظ":(boxes.length>N?"مربعات أكثر من المطلوب":boxes.length<N?"مربعات ناقصة":"غطِّ الخلايا الحمراء");st.className=valid?"ok":"no";
  document.getElementById("mzedSave").disabled=!valid;
  document.getElementById("mzedSave").style.opacity=valid?1:.4;
  // لوحة المربع المحدد
  const box=document.getElementById("mzedSelBox");
  if(mzE.sel>=0&&boxes[mzE.sel]){
    box.style.display="block";const b=boxes[mzE.sel];
    document.getElementById("mzedSelSize").textContent=`(${b[2]}×${b[3]}، الأهمية #${rank[mzE.sel]})`;
    const sel=document.getElementById("mzedPin");
    sel.innerHTML=`<option value="">⚡ تلقائي (حسب عدد المنتجات)</option>`+categoriesData.map(c=>`<option value="${c.id}"${b[4]===c.id?' selected':''}>${htmlEscape(getCatPath(c.id))}</option>`).join("");
  } else box.style.display="none";
}
function mzPush(){mzE.hist.push(JSON.stringify(mzE.boxes));if(mzE.hist.length>60)mzE.hist.shift();mzE.touched=true;}
function mzFits(nb,skip){
  const {S,boxes}=mzE;const [c,r,w,h]=nb;
  if(c<0||r<0||w<1||h<1||c+w>S||r+h>S)return false;
  for(let j=0;j<boxes.length;j++){if(j===skip)continue;const o=boxes[j];if(c<o[0]+o[2]&&c+w>o[0]&&r<o[1]+o[3]&&r+h>o[1])return false;}
  return true;
}
function mzEdInit(){
  const cv=document.getElementById("mzedCanvas");
  cv.addEventListener("pointerdown",e=>{
    const t=e.target.closest(".mzed-tile");
    if(!t){mzE.sel=-1;mzEdRender();return;}
    const i=+t.dataset.i;
    if(e.target.closest(".mzed-x")){mzPush();mzE.boxes.splice(i,1);mzE.sel=-1;mzEdRender();return;}
    mzE.sel=i;
    const rect=cv.getBoundingClientRect();
    mzE.drag={i,mode:e.target.closest(".mzed-rz")?"resize":"move",sx:e.clientX,sy:e.clientY,orig:mzE.boxes[i].slice(),cell:rect.width/mzE.S,moved:false,hist:JSON.stringify(mzE.boxes)};
    mzEdRender();e.preventDefault();
  });
  window.addEventListener("pointermove",e=>{
    const d=mzE.drag;if(!d)return;
    const dc=Math.round((d.sx-e.clientX)/d.cell),dr=Math.round((e.clientY-d.sy)/d.cell); // RTL: السحب لليسار يزيد رقم العمود
    const o=d.orig;
    const nb=d.mode==="move"?[o[0]+dc,o[1]+dr,o[2],o[3],o[4]]:[o[0],o[1],Math.max(1,o[2]+dc),Math.max(1,o[3]+dr),o[4]];
    const cur=mzE.boxes[d.i];
    if(nb[0]===cur[0]&&nb[1]===cur[1]&&nb[2]===cur[2]&&nb[3]===cur[3])return;
    if(mzFits(nb,d.i)){mzE.boxes[d.i]=nb;d.moved=true;mzEdRender();}
  });
  const end=()=>{const d=mzE.drag;if(!d)return;if(d.moved){mzE.hist.push(d.hist);mzE.touched=true;}mzE.drag=null;mzEdRender();};
  window.addEventListener("pointerup",end);window.addEventListener("pointercancel",end);
  document.getElementById("mzedN").onchange=e=>{
    let n=Math.max(3,Math.min(23,parseInt(e.target.value)||6));
    if(mzE.touched&&!confirm("سيتم تجاهل التعديلات غير المحفوظة. متابعة؟")){e.target.value=mzE.N;return;}
    mzEdLoad(n);
  };
  document.getElementById("mzedS").onchange=e=>{
    const S=+e.target.value;
    if(mzE.touched&&!confirm("تغيير دقة الشبكة يعيد توليد التوزيع. متابعة؟")){e.target.value=String(mzE.S);return;}
    mzE.S=S;const a=mzAuto(mzE.N,S);
    mzE.boxes=a?a.map(b=>[b[0],b[1],b[2],b[3],null]):[];
    if(!a)showToast("لا يوجد توزيع تلقائي لهذا العدد بهذه الدقة — ابدأ بإضافة المربعات يدوياً.","info");
    mzE.sel=-1;mzE.hist=[];mzE.touched=false;mzEdSync();
  };
  document.getElementById("mzedAuto").onclick=()=>{
    const a=mzAuto(mzE.N,mzE.S);
    if(!a){showToast("لا يوجد توزيع تلقائي لهذا العدد بهذه الدقة. جرّب دقة أخرى.","error");return;}
    mzPush();mzE.boxes=a.map(b=>[b[0],b[1],b[2],b[3],null]);mzE.sel=-1;mzEdRender();
  };
  document.getElementById("mzedAdd").onclick=()=>{
    const {S}=mzE;const {own}=mzCoverage();
    for(let r=0;r<S;r++)for(let c=0;c<S;c++)if(own[r][c]<0){mzPush();mzE.boxes.push([c,r,1,1,null]);mzE.sel=mzE.boxes.length-1;mzEdRender();return;}
    showToast("لا توجد خلايا فارغة. صغّر مربعاً أولاً.","info");
  };
  document.getElementById("mzedUndo").onclick=()=>{const h=mzE.hist.pop();if(!h){showToast("لا شيء للتراجع عنه","info");return;}mzE.boxes=JSON.parse(h);mzE.sel=-1;mzEdRender();};
  document.getElementById("mzedClear").onclick=()=>{mzPush();mzE.boxes=[];mzE.sel=-1;mzEdRender();};
  document.getElementById("mzedCirc").onclick=()=>{mzE.circ=!mzE.circ;document.getElementById("mzedCanvas").classList.toggle("circ",mzE.circ);};
  document.getElementById("mzedPin").onchange=e=>{
    const b=mzE.boxes[mzE.sel];if(!b)return;mzPush();
    const v=e.target.value||null;
    if(v)mzE.boxes.forEach(x=>{if(x[4]===v)x[4]=null;});
    b[4]=v;mzEdRender();
  };
  document.getElementById("mzedSave").onclick=async()=>{
    const {N,S}=mzE;const {unc}=mzCoverage();
    if(mzE.boxes.length!==N||unc!==0)return;
    const previous=mzL[N];
    mzL[N]={S,boxes:mzE.boxes.map(b=>b[4]?[b[0],b[1],b[2],b[3],b[4]]:[b[0],b[1],b[2],b[3]])};
    try{
      await mzPersist("✅ تم حفظ قالب الـ "+N+" مربعات");
      mzE.touched=false;mzEdSync();
    }catch(e){
      if(previous)mzL[N]=previous;else delete mzL[N];
      console.error("Mosaic layout save failed:",e);
      showToast("فشل حفظ قالب الفسيفساء في Supabase.","error");
    }
  };
  document.getElementById("mzedDel").onclick=async()=>{
    if(!mzL[mzE.N]){showToast("لا يوجد قالب مخصص لهذا العدد","info");return;}
    if(!confirm("حذف القالب المخصص والعودة للتوزيع التلقائي لهذا العدد؟"))return;
    const n=mzE.N,previous=mzL[n];
    delete mzL[n];
    try{await mzPersist("تم حذف القالب المخصص");mzEdLoad(n);}
    catch(e){mzL[n]=previous;console.error("Mosaic layout delete failed:",e);showToast("فشل حذف قالب الفسيفساء.","error");}
  };
  document.getElementById("mzedCopy").onclick=()=>{
    const ta=document.getElementById("mzedExport");ta.select();
    try{navigator.clipboard.writeText(ta.value);}catch(e){document.execCommand("copy");}
    showToast("تم النسخ","success");
  };
}
async function mzPersist(okMsg){
  showLoading();
  try{
    const layout=mzL[mzE.N];
    const result=layout
      ?await sbClient.from("mosaic_layouts").upsert({
        category_count:mzE.N,grid_size:mzE.S,boxes:layout.boxes,
      })
      :await sbClient.from("mosaic_layouts").delete().eq("category_count",mzE.N);
    const {error}=result;
    if(error)throw error;
    showToast(okMsg,"success");
  }
  finally{hideLoading();}
}
