// ============================================================
// INITIAL DATA (fallback — used to seed the sheet first time)
// ============================================================
const INIT={"lk":{"cv":[],"gr":[],"an":[],"es":[],"tp":[]},"months":[]};
let LK=INIT.lk;

function applyRemoteLookups(lookups){
 if(!lookups||typeof lookups!=="object")return;
 for(const key of ["cv","gr","an","es","tp"]){
  if(Array.isArray(lookups[key]))LK[key]=lookups[key];
 }
}
const CLS_L={9:'⬆⬆⬆⬆',8:'⬆⬆⬆',7:'⬆⬆',6:'⬆',5:'➡',4:'⬇',3:'⬇⬇',2:'⬇⬇⬇',1:'⬇⬇⬇⬇',0:'—'};

// ============================================================
// STATE
// ============================================================
let DB={months:[]};
let CPV={};
let pendingCPV={};

// Metas por trimestre — preserva histórico quando OKR muda
// Q1 2026: 85 clientes (meta original, fechada)
// Q2 2026: 60 clientes (nova meta)
// Adicione entradas aqui quando a meta mudar novamente
let TARGETS={
 "2026-Q1":85,
 "2026-Q2":60,
 "2026-Q3":60,
 "2026-Q4":60
};
const DEFAULT_TARGET=60;
function normalizeTargets(targets){
 const clean={};
 if(!targets||typeof targets!=='object')return clean;
 for(const [key,value] of Object.entries(targets)){
  const k=String(key).trim().toUpperCase(),v=Math.round(Number(value));
  if(/^\d{4}-Q[1-4]$/.test(k)&&Number.isFinite(v)&&v>0)clean[k]=v;
 }
 return clean;
}
function applyRemoteTargets(targets){
 const clean=normalizeTargets(targets);
 if(Object.keys(clean).length)TARGETS={...TARGETS,...clean};
}
function getTargetForMonth(monthId){
 const parts=String(monthId).split('-');
 const yr=parseInt(parts[0])||0;
 const mo=parseInt(parts[1])||0;
 const q=Math.ceil(mo/3);
 const key=yr+'-Q'+q;
 return TARGETS[key]||DEFAULT_TARGET;
}
function getCurrentQuarterKey(){
 const lastIdx=DB.months.length-1;
 if(lastIdx<0){const d=new Date();return d.getFullYear()+'-Q'+Math.ceil((d.getMonth()+1)/3);}
 const m=DB.months[lastIdx];
 const parts=String(m.id).split('-');
 const yr=parseInt(parts[0])||0;
 const mo=parseInt(parts[1])||0;
 return yr+'-Q'+Math.ceil(mo/3);
}

// Baseline = snapshot "Ambos" no último mês do trimestre ANTERIOR ao trimestre informado.
// Esta é a "largada" do trimestre — o ponto de partida contra o qual medimos esforço incremental.
// Retorna {baseline, baselineMonth, hasBaseline}
// - baseline: número de "Ambos" na largada (0 se não há trimestre anterior)
// - baselineMonth: nome do mês de referência (ou null)
// - hasBaseline: false se este é o primeiro trimestre da série
function getBaselineForQuarter(year,quarter){
 // Procura o último mês ANTES de (year, quarter*3-2) — o primeiro mês deste Q
 const firstMonthOfQ=(quarter-1)*3+1;
 // Encontra o último mês da DB cujo ano<year OR (ano==year AND mês<firstMonthOfQ)
 let lastPrevIdx=-1;
 for(let i=DB.months.length-1;i>=0;i--){
  const parts=String(DB.months[i].id).split('-');
  const yr=parseInt(parts[0])||0;
  const mo=parseInt(parts[1])||0;
  if(yr<year||(yr===year&&mo<firstMonthOfQ)){
   lastPrevIdx=i;break;
  }
 }
 // Label da largada = primeiro mês do trimestre vigente (ex: Q2 2026 → "Abril 2026")
 const startMonthLabel=MONTH_PT[firstMonthOfQ-1]+' '+year;
 if(lastPrevIdx<0)return{baseline:0,baselineMonth:null,startMonth:startMonthLabel,hasBaseline:false};
 // Para o baseline, NÃO aplicamos CPV ao vivo — usamos o snapshot histórico
 const m=computeMonthMetrics(lastPrevIdx,false);
 return{
  baseline:m?m.current:0,
  baselineMonth:DB.months[lastPrevIdx].name,// snapshot de referência (Março)
  startMonth:startMonthLabel,// largada efetiva (Abril)
  hasBaseline:true
 };
}

// Computa métricas INCREMENTAIS do trimestre atual contra a largada
// Retorna {baseline, baselineMonth, current, target, delta, deltaNeeded, pctIncremental, hasBaseline}
// - delta = current - baseline (quantos clientes conquistados neste Q)
// - deltaNeeded = target - baseline (esforço total necessário no Q)
// - pctIncremental = delta / deltaNeeded * 100 (% do esforço já realizado)
function computeQuarterProgress(){
 const lastIdx=DB.months.length-1;
 if(lastIdx<0)return null;
 const cur=computeMonthMetrics(lastIdx,true);
 if(!cur)return null;
 const parts=String(DB.months[lastIdx].id).split('-');
 const yr=parseInt(parts[0])||0;
 const mo=parseInt(parts[1])||0;
 const q=Math.ceil(mo/3);
 const bl=getBaselineForQuarter(yr,q);
 const target=cur.target;
 const delta=cur.current-bl.baseline;
 const deltaNeeded=Math.max(0,target-bl.baseline);
 const pctIncremental=deltaNeeded>0?Math.min(100,Math.round((delta/deltaNeeded)*1000)/10):(delta>=0?100:0);
 const remaining=Math.max(0,target-cur.current);
 return{
  baseline:bl.baseline,
  baselineMonth:bl.baselineMonth,
  startMonth:bl.startMonth,
  hasBaseline:bl.hasBaseline,
  current:cur.current,
  target,
  delta,
  deltaNeeded,
  pctIncremental,
  remaining,
  pctAbsolute:cur.pct,
  quarterLabel:'Q'+q+' '+yr
 };
}
// After a successful toggle, we "pin" the value for 30s so stale polling reads can't undo it
let recentlyConfirmed={}; // {cnpj: {value: bool, until: timestamp}}
const CONFIRM_TTL=30000; // 30s

function isRecentlyConfirmed(cnpj){
 const rc=recentlyConfirmed[cnpj];
 if(!rc)return null;
 if(Date.now()>rc.until){delete recentlyConfirmed[cnpj];return null}
 return rc.value;
}

let currentUser=null;
function isAdmin(){return currentUser&&currentUser.role==='admin'}
// CP Validado toggle rendering
// - If client already has CP=Sim via system: shows as "auto-marked" (esmaecido), uneditable
// - If admin: shows interactive toggle
// - If member: shows current state, locked
function cpvTogHTML(cnpj,cpSys){
 // Auto-marked when CP Sistema = Sim (cannot be unchecked)
 if(cpSys===true){
  return `<div class="cpv-toggle on auto" title="CP ativo via sistema — sempre validado"></div><span class="cpv-label on">Sim</span><span class="cpv-auto">auto</span>`;
 }
 const cpv=CPV[cnpj]===true;
 const pend=pendingCPV[cnpj]!==undefined;
 const locked=!isAdmin();
 const cls=`cpv-toggle ${cpv?'on':''} ${pend?'pending':''} ${locked?'locked':''}`;
 const click=locked?`onclick="toast('Apenas administradores podem editar',true)"`:`onclick="toggleCPV('${cnpj}')"`;
 return `<div class="${cls}" ${click} title="${locked?'Somente leitura':'Clique para alternar'}"></div><span class="cpv-label ${cpv?'on':'off'}">${cpv?'Sim':'—'}</span>`;
}
let apiURL=(window.OKR_CONFIG&&window.OKR_CONFIG.appsScriptUrl)||localStorage.getItem('okr-apx-api-url')||'';
let authToken=null;
let lastSync=0;
let syncTimer=null;

let tab='overview',searchVal='',pipeF='all',baseF='all',sortC='dias',sortD='desc',pg=0,viewMi=-1,histMi=-1;
let drilldown=null;
const PP=50;

function dec(r){
 function look(v,arr){if(typeof v==='string')return v;if(v>=0&&arr[v])return arr[v];return '—'}
 return{c:r[0],n:r[1],cp:r[2]===1,tl:r[3]===1,cav:look(r[4],LK.cv),ger:look(r[5],LK.gr),ana:look(r[6],LK.an),tipo:look(r[7],LK.tp),est:look(r[8],LK.es),cls:r[9],dias:r[10],ct:r[11]}
}

// Normalize months: ensure id/name are strings, fix Sheets auto-conversion
const MONTH_PT=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
function normalizeMonths(months){
 if(!Array.isArray(months))return [];
 return months.map(m=>{
  let id=String(m.id||'');
  let name=String(m.name||'');
  // Sheets converts "2026-01" → 202601 or date object
  if(id.match(/^\d{6}$/))id=id.substring(0,4)+'-'+id.substring(4,6);
  if(id.includes('GMT')||id.includes('T00')){
   try{const d=new Date(id);id=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')}catch(e){}
  }
  // Detect date-formatted names like "Thu Apr 01 2026"
  if(name.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/)||name.includes('GMT')||name.includes('T00')){
   try{
    const d=new Date(name);
    if(!isNaN(d.getTime()))name=MONTH_PT[d.getMonth()]+' '+d.getFullYear();
   }catch(e){}
  }
  // If name is empty or = id, derive from id
  if(!name||name===id){
   const parts=id.split('-');
   if(parts.length===2){
    const mi=parseInt(parts[1])-1;
    if(mi>=0&&mi<12)name=MONTH_PT[mi]+' '+parts[0];
    else name=id;
   }else name=id;
  }
  return{...m,id,name};
 });
}
function sortMonths(arr){return arr.sort((a,b)=>String(a.id).localeCompare(String(b.id)))}
function fmt(n){return n!=null?n.toLocaleString('pt-BR'):'—'}
function fmtD(n){return n!=null?n.toLocaleString('pt-BR',{maximumFractionDigits:1}):'—'}
function pct(v,t){return t?Math.round(v/t*100):0}
function clsB(c){return`<span class="cls-badge cls-${c}">${CLS_L[c]||'—'}</span>`}
function tagYN(v){return`<span class="tg ${v?'y':'n'}">${v?'Sim':'Não'}</span>`}
function latI(){return DB.months.length-1}
function lat(){return DB.months[latI()]}

function toast(m,err){
 const t=document.getElementById('toast');
 t.textContent=m;
 t.className='toast show'+(err?' err':'');
 setTimeout(()=>t.classList.remove('show'),2800);
}

// ============================================================
// API LAYER — Google Apps Script backend
// ============================================================
const API_TIMEOUT=30000; // 30s timeout
const CACHE_KEY='okr-apx-cache-v1';

async function apiCall(action,data){
 if(!apiURL)throw new Error('URL do backend não configurada');
 console.log('[API] POST',action,data);
 const ctrl=new AbortController();
 const tId=setTimeout(()=>ctrl.abort(),API_TIMEOUT);
 try{
  const res=await fetch(apiURL+'?action='+action,{
   method:'POST',
   body:JSON.stringify({...data,token:authToken}),
   redirect:'follow',
   signal:ctrl.signal
  });
  clearTimeout(tId);
  const txt=await res.text();
  console.log('[API] Response',action,'→',txt.substring(0,200));
  try{return JSON.parse(txt)}catch(e){throw new Error('Resposta inválida do servidor: '+txt.substring(0,100))}
 }catch(e){
  clearTimeout(tId);
  if(e.name==='AbortError')throw new Error('Timeout: o servidor demorou mais de 30 segundos');
  console.error('[API] error:',e);
  throw e;
 }
}

async function apiGet(action){
 if(!apiURL)throw new Error('URL do backend não configurada');
 console.log('[API] GET',action);
 const ctrl=new AbortController();
 const tId=setTimeout(()=>ctrl.abort(),API_TIMEOUT);
 try{
  const url=new URL(apiURL);url.searchParams.set('action',action);if(authToken)url.searchParams.set('token',authToken);
  const res=await fetch(url.toString(),{signal:ctrl.signal});
  clearTimeout(tId);
  const txt=await res.text();
  console.log('[API] Response',action,'→ size:',txt.length,'bytes');
  try{return JSON.parse(txt)}catch(e){throw new Error('Resposta inválida: '+txt.substring(0,100))}
 }catch(e){
  clearTimeout(tId);
  if(e.name==='AbortError')throw new Error('Timeout: o servidor demorou mais de 30 segundos');
  console.error('[API] error:',e);
  throw e;
 }
}

// Cache helpers
function saveCache(){
 try{
  localStorage.setItem(CACHE_KEY,JSON.stringify({months:DB.months,cpv:CPV,ts:Date.now()}));
  console.log('[CACHE] Saved',DB.months.length,'months');
 }catch(e){console.warn('[CACHE] save failed:',e)}
}
function loadCache(){
 try{
  const raw=localStorage.getItem(CACHE_KEY);
  if(!raw)return null;
  const c=JSON.parse(raw);
  console.log('[CACHE] Loaded',c.months.length,'months, age:',Math.round((Date.now()-c.ts)/1000),'s');
  return c;
 }catch(e){return null}
}
function clearCache(){try{localStorage.removeItem(CACHE_KEY)}catch(e){}}

// ============================================================
// LOGIN FLOW
// ============================================================
function showSetupModal(){
 document.getElementById('modal-root').innerHTML=`
 <div class="setup-modal-bg" onclick="closeModal()">
  <div class="setup-modal" onclick="event.stopPropagation()">
   <h2>⚙ Configuração do Backend</h2>
   <p>Cole aqui a URL do seu Google Apps Script (Web App). Essa URL conecta o painel ao seu Google Sheets para que todos os colaboradores vejam os mesmos dados. <br><br>📖 Consulte o arquivo <code>GUIA_SETUP.md</code> para obter essa URL.</p>
   <label>URL do Apps Script</label>
   <input type="text" id="setup-url" placeholder="https://script.google.com/macros/s/.../exec" value="${apiURL}">
   <div class="modal-btns">
    <button class="btn" onclick="closeModal()">Cancelar</button>
    <button class="btn btn-p" onclick="saveSetupURL()">Salvar e Testar</button>
   </div>
  </div>
 </div>`;
}

async function saveSetupURL(){
 const url=document.getElementById('setup-url').value.trim();
 if(!url){toast('URL obrigatória',true);return}
 if(!url.includes('script.google.com')){toast('URL inválida',true);return}
 apiURL=url;
 localStorage.setItem('okr-apx-api-url',url);
 toast('Testando conexão...');
 try{
  const r=await apiGet('ping');
  if(r.ok){toast('Conexão estabelecida!');closeModal()}
  else toast('Falha na conexão',true);
 }catch(e){toast('Erro: '+e.message,true)}
}

function closeModal(){document.getElementById('modal-root').innerHTML=''}

function showTargetModal(selectedKey){
 if(!isAdmin()){toast('Apenas administradores podem ajustar metas',true);return}
 const currentKey=selectedKey||getCurrentQuarterKey();
 const configured=Object.entries(TARGETS).sort(([a],[b])=>a.localeCompare(b));
 document.getElementById('modal-root').innerHTML=`
 <div class="modal-bg" onclick="closeModal()"><div class="modal" onclick="event.stopPropagation()">
  <h2>🎯 Metas por trimestre</h2>
  <p>Cada trimestre mantém sua própria meta sem alterar o histórico dos demais períodos.</p>
  <label>Trimestre (AAAA-Qn)</label><input type="text" id="target-quarter" value="${currentKey}" maxlength="7">
  <label>Meta de clientes com ambos os produtos</label><input type="number" id="target-value" value="${TARGETS[currentKey]||DEFAULT_TARGET}" min="1" step="1">
  <div class="target-list">${configured.map(([key,value])=>`<button type="button" class="target-row" onclick="showTargetModal('${key}')"><span>${key}</span><strong>${value} clientes</strong></button>`).join('')}</div>
  <div class="modal-btns"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-p" id="target-save" onclick="saveQuarterTarget()">Salvar meta</button></div>
 </div></div>`;
}

async function saveQuarterTarget(){
 const key=String(document.getElementById('target-quarter').value||'').trim().toUpperCase();
 const target=Math.round(Number(document.getElementById('target-value').value));
 if(!/^\d{4}-Q[1-4]$/.test(key)){toast('Use o formato AAAA-Qn',true);return}
 if(!Number.isFinite(target)||target<1){toast('Informe uma meta inteira maior que zero',true);return}
 const result=await apiCall('save_target',{quarter:key,target,user:currentUser.email});
 if(!result.ok){toast(result.error||'Erro ao salvar meta',true);return}
 TARGETS={...TARGETS,[key]:target};closeModal();render();toast('Meta atualizada');
}

async function doLogin(){
 const email=document.getElementById('login-email').value.trim();
 const pass=document.getElementById('login-pass').value.trim();
 const errDiv=document.getElementById('login-err');
 errDiv.innerHTML='';
 if(!email||!pass){errDiv.innerHTML='<div class="login-err">Preencha email e senha</div>';return}
 if(!apiURL){errDiv.innerHTML='<div class="login-err">Configure o backend primeiro (link abaixo)</div>';return}
 const btn=document.getElementById('login-btn');
 btn.disabled=true;btn.textContent='Autenticando...';
 try{
  const r=await apiCall('login',{email,password:pass});
  if(r.ok){
   currentUser=r.user;authToken=r.token;
   localStorage.setItem('okr-apx-user',JSON.stringify(r.user));
   localStorage.setItem('okr-apx-token',r.token);
   await enterApp();
  }else{
   errDiv.innerHTML='<div class="login-err">'+(r.error||'Credenciais inválidas')+'</div>';
   btn.disabled=false;btn.textContent='Entrar no Painel';
  }
 }catch(e){
  errDiv.innerHTML='<div class="login-err">Erro de conexão: '+e.message+'</div>';
  btn.disabled=false;btn.textContent='Entrar no Painel';
 }
}

function showLoadingState(text,showButtons){
 const lw=document.getElementById('loading-wrap');
 lw.style.display='flex';
 const truckScene=`<div class="loading-scene"><div class="loading-road"></div><div class="loading-truck"><svg class="loading-truck-svg" viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg"><circle class="exhaust" cx="8" cy="22" r="3" fill="#9d5fe0" opacity="0"/><circle class="exhaust" cx="4" cy="18" r="2" fill="#9d5fe0" opacity="0" style="animation-delay:.4s"/><rect x="14" y="12" width="60" height="30" rx="2" fill="#7d3dc5" stroke="#9d5fe0" stroke-width="1.2"/><rect x="18" y="16" width="52" height="22" rx="1" fill="none" stroke="#c084fc" stroke-width=".5" opacity=".5"/><text x="44" y="32" font-family="Instrument Sans,sans-serif" font-size="11" font-weight="800" fill="#f0ecfa" text-anchor="middle" letter-spacing="1">PX</text><path d="M74 18 L74 42 L104 42 L104 28 L96 28 L92 18 Z" fill="#9d5fe0" stroke="#c084fc" stroke-width="1"/><path d="M94 20 L96 28 L102 28 L102 22 Z" fill="#4d8fff" opacity=".7"/><rect x="102" y="32" width="3" height="4" rx="1" fill="#fbbf24"/><g class="wheel"><circle cx="30" cy="46" r="6" fill="#1a1628" stroke="#c084fc" stroke-width="1.2"/><circle cx="30" cy="46" r="2" fill="#7d3dc5"/><line x1="30" y1="41" x2="30" y2="51" stroke="#9d5fe0" stroke-width="1"/><line x1="25" y1="46" x2="35" y2="46" stroke="#9d5fe0" stroke-width="1"/></g><g class="wheel" style="animation-delay:-.1s"><circle cx="54" cy="46" r="6" fill="#1a1628" stroke="#c084fc" stroke-width="1.2"/><circle cx="54" cy="46" r="2" fill="#7d3dc5"/><line x1="54" y1="41" x2="54" y2="51" stroke="#9d5fe0" stroke-width="1"/><line x1="49" y1="46" x2="59" y2="46" stroke="#9d5fe0" stroke-width="1"/></g><g class="wheel" style="animation-delay:-.2s"><circle cx="90" cy="46" r="6" fill="#1a1628" stroke="#c084fc" stroke-width="1.2"/><circle cx="90" cy="46" r="2" fill="#7d3dc5"/><line x1="90" y1="41" x2="90" y2="51" stroke="#9d5fe0" stroke-width="1"/><line x1="85" y1="46" x2="95" y2="46" stroke="#9d5fe0" stroke-width="1"/></g></svg></div></div>`;
 lw.innerHTML=`
 <div class="loading-inner" style="max-width:420px">
  ${truckScene}
  <div class="loading-text" id="loading-text">${text.replace(/\.+$/,'')}</div>
  <div class="loading-text-sub">Academia PX · Em rota</div>
  ${showButtons?`
  <div style="display:flex;gap:8px;justify-content:center;margin-top:20px;flex-wrap:wrap">
   <button class="btn btn-p" onclick="enterApp()">🔄 Tentar novamente</button>
   <button class="btn" onclick="enterAppFromCache()">📦 Usar dados em cache</button>
   <button class="btn" onclick="logout()">⏻ Voltar ao login</button>
  </div>`:''}
 </div>`;
}

async function enterAppFromCache(){
 const cache=loadCache();
 if(!cache||!cache.months||!cache.months.length){
  toast('Sem dados em cache',true);
  return;
 }
 DB.months=normalizeMonths(cache.months);
 CPV=cache.cpv||{};
 DB.months=sortMonths(normalizeMonths(DB.months));
 lastSync=cache.ts||Date.now();
 document.getElementById('loading-wrap').style.display='none';
 document.getElementById('app').classList.add('ready');
 render();
 startSyncPolling();
 toast('Carregado do cache local');
}

async function enterApp(){
 document.getElementById('login-wrap').style.display='none';
 showLoadingState('Conectando ao servidor',false);

 // Try to use cache immediately while loading fresh data in background
 const cache=loadCache();
 let cacheShown=false;
 if(cache&&cache.months&&cache.months.length>0){
  console.log('[INIT] Cache found, showing immediately');
  DB.months=normalizeMonths(cache.months);
  CPV=cache.cpv||{};
  DB.months=sortMonths(normalizeMonths(DB.months));
  lastSync=cache.ts;
  document.getElementById('loading-wrap').style.display='none';
  document.getElementById('app').classList.add('ready');
  render();
  cacheShown=true;
  toast('Carregado do cache · atualizando em segundo plano...');
 }

 try{
  console.log('[INIT] Fetching fresh data from server...');
  const r=await apiGet('get_all');
  console.log('[INIT] Response received, ok:',r.ok,'months:',(r.months||[]).length);
  if(!r.ok)throw new Error(r.error||'Erro desconhecido');

  if(r.months&&r.months.length>0){
   DB.months=normalizeMonths(r.months);
  }else if(!cacheShown){
   // First time ever: seed with initial data
   showLoadingState('Primeiro acesso: enviando dados iniciais (isso pode levar 30 segundos)...',false);
   console.log('[INIT] Seeding initial data...');
   for(let i=0;i<INIT.months.length;i++){
    const m=INIT.months[i];
    document.getElementById('loading-text').textContent=`Enviando ${m.name} (${i+1}/${INIT.months.length})...`;
    await apiCall('save_month',{month:m,user:currentUser.email});
   }
   DB.months=[...INIT.months];
  }
  CPV=r.cpv||{};
  applyRemoteLookups(r.lk);
  applyRemoteTargets(r.targets);
  DB.months=sortMonths(normalizeMonths(DB.months));
  lastSync=Date.now();
  saveCache();

  if(!cacheShown){
   document.getElementById('loading-wrap').style.display='none';
   document.getElementById('app').classList.add('ready');
   render();
   startSyncPolling();
  }else{
   // Re-render with fresh data
   render();
   toast('Dados atualizados');
   if(!syncTimer)startSyncPolling();
  }
 }catch(e){
  console.error('[INIT] Error:',e);
  if(cacheShown){
   // Already showing cache, just warn
   toast('Falha ao atualizar: '+e.message+' (usando cache)',true);
   if(!syncTimer)startSyncPolling();
  }else{
   // Show error with retry options
   showLoadingState('❌ Erro ao carregar: '+e.message,true);
  }
 }
}

function logout(){
 localStorage.removeItem('okr-apx-user');
 localStorage.removeItem('okr-apx-token');
 clearCache();
 currentUser=null;authToken=null;
 if(syncTimer){clearInterval(syncTimer);syncTimer=null}
 document.getElementById('app').classList.remove('ready');
 document.getElementById('loading-wrap').style.display='none';
 document.getElementById('login-wrap').style.display='flex';
 // Restore original loading wrap content
 document.getElementById('loading-wrap').innerHTML=`<div class="loading-inner"><div class="loading-scene"><div class="loading-road"></div><div class="loading-truck"><svg class="loading-truck-svg" viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg"><circle class="exhaust" cx="8" cy="22" r="3" fill="#9d5fe0" opacity="0"/><circle class="exhaust" cx="4" cy="18" r="2" fill="#9d5fe0" opacity="0" style="animation-delay:.4s"/><rect x="14" y="12" width="60" height="30" rx="2" fill="#7d3dc5" stroke="#9d5fe0" stroke-width="1.2"/><text x="44" y="32" font-family="Instrument Sans,sans-serif" font-size="11" font-weight="800" fill="#f0ecfa" text-anchor="middle" letter-spacing="1">PX</text><path d="M74 18 L74 42 L104 42 L104 28 L96 28 L92 18 Z" fill="#9d5fe0" stroke="#c084fc" stroke-width="1"/><path d="M94 20 L96 28 L102 28 L102 22 Z" fill="#4d8fff" opacity=".7"/><rect x="102" y="32" width="3" height="4" rx="1" fill="#fbbf24"/><g class="wheel"><circle cx="30" cy="46" r="6" fill="#1a1628" stroke="#c084fc" stroke-width="1.2"/><circle cx="30" cy="46" r="2" fill="#7d3dc5"/></g><g class="wheel" style="animation-delay:-.1s"><circle cx="54" cy="46" r="6" fill="#1a1628" stroke="#c084fc" stroke-width="1.2"/><circle cx="54" cy="46" r="2" fill="#7d3dc5"/></g><g class="wheel" style="animation-delay:-.2s"><circle cx="90" cy="46" r="6" fill="#1a1628" stroke="#c084fc" stroke-width="1.2"/><circle cx="90" cy="46" r="2" fill="#7d3dc5"/></g></svg></div></div><div class="loading-text" id="loading-text">Carregando dados</div><div class="loading-text-sub">Academia PX · Em rota</div></div>`;
 document.getElementById('login-err').innerHTML='';
 document.getElementById('login-btn').disabled=false;
 document.getElementById('login-btn').textContent='Entrar no Painel';
}

// ============================================================
// SYNC POLLING (every 15s, pulls latest from server)
// PRESERVES pending CPV toggles until the server confirms them
// ============================================================
function startSyncPolling(){
 if(syncTimer)clearInterval(syncTimer);
 syncTimer=setInterval(async()=>{
  // Skip sync if there are pending CPV toggles in flight (wait for them to confirm)
  if(Object.keys(pendingCPV).length>0){
   console.log('[SYNC] Skipping — pending CPV toggles:',Object.keys(pendingCPV).length);
   updateSyncBadge();
   return;
  }
  try{
   const r=await apiGet('get_all');
   if(r.ok){
    const prevCpvStr=JSON.stringify(CPV);
    const prevMonthCount=DB.months.length;
    if(r.months)DB.months=normalizeMonths(r.months);
    applyRemoteLookups(r.lk);
    applyRemoteTargets(r.targets);
    DB.months=sortMonths(normalizeMonths(DB.months));
    // Merge server CPV with any pending + recently-confirmed toggles
    const serverCPV=r.cpv||{};
    const mergedCPV={...serverCPV};
    // Pending wins (not yet confirmed)
    for(const k in pendingCPV){
     if(pendingCPV[k]===true)mergedCPV[k]=true;
     else delete mergedCPV[k];
    }
    // Recently-confirmed also wins (protect against stale server reads for 30s)
    for(const k in recentlyConfirmed){
     const rc=isRecentlyConfirmed(k);
     if(rc===true)mergedCPV[k]=true;
     else if(rc===false)delete mergedCPV[k];
    }
    CPV=mergedCPV;
    _pipelineCache=null;
    lastSync=Date.now();
    saveCache();
    const newCpvStr=JSON.stringify(CPV);
    if(newCpvStr!==prevCpvStr||DB.months.length!==prevMonthCount){
     renderPreserveScroll();
    }else updateSyncBadge();
   }
  }catch(e){console.error('[SYNC] error:',e)}
 },15000);
}

function updateSyncBadge(){
 const el=document.getElementById('sync-badge');
 if(el){
  const secs=Math.floor((Date.now()-lastSync)/1000);
  el.textContent='Sincronizado há '+secs+'s';
 }
}

// Re-render while preserving scroll position, search focus and cursor
// Used when state changes happen mid-interaction (CPV toggles, background sync)
function renderPreserveScroll(){
 const scrollY=window.scrollY;
 const activeEl=document.activeElement;
 const isSearchFocused=activeEl&&activeEl.id==='srch';
 const searchPos=isSearchFocused?activeEl.selectionStart:null;
 render();
 // Restore scroll position after the DOM has repainted
 requestAnimationFrame(()=>{
  window.scrollTo({top:scrollY,behavior:'instant'});
  if(isSearchFocused){
   const ns=document.getElementById('srch');
   if(ns){ns.focus();if(searchPos!=null)ns.setSelectionRange(searchPos,searchPos)}
  }
 });
}

// ============================================================
// CPV TOGGLE (optimistic update + API call)
// ============================================================
async function toggleCPV(cnpj){
 if(!isAdmin()){toast('Apenas administradores podem editar CP Validado',true);return}
 // Block toggling for clients that already have CP via system (auto-marked)
 const latRow=lat().rows.find(r=>r[0]===cnpj);
 if(latRow&&latRow[2]===1){
  toast('Cliente já possui CP via sistema — sempre validado',true);
  return;
 }
 const newVal=!CPV[cnpj];
 console.log('[CPV] Toggling',cnpj,'to',newVal);
 // Optimistic update
 if(newVal)CPV[cnpj]=true;else delete CPV[cnpj];
 pendingCPV[cnpj]=newVal;
 _pipelineCache=null;
 renderPreserveScroll();
 try{
  const r=await apiCall('toggle_cpv',{cnpj,value:newVal,user:currentUser.email});
  if(r.ok){
   console.log('[CPV] Server confirmed',cnpj,'=',newVal);
   delete pendingCPV[cnpj];
   // Pin this value for 30s to protect against stale polling reads
   recentlyConfirmed[cnpj]={value:newVal,until:Date.now()+CONFIRM_TTL};
   // Force server state to match (ensure our local is canonical)
   if(newVal)CPV[cnpj]=true;else delete CPV[cnpj];
   _pipelineCache=null;
   saveCache();
   toast(newVal?'CP Validado ativado':'CP Validado removido');
  }else{
   // Rollback
   console.warn('[CPV] Server rejected:',r.error);
   if(newVal)delete CPV[cnpj];else CPV[cnpj]=true;
   delete pendingCPV[cnpj];
   _pipelineCache=null;
   renderPreserveScroll();
   toast('Erro: '+(r.error||'falha'),true);
  }
 }catch(e){
  console.error('[CPV] Network error:',e);
  if(newVal)delete CPV[cnpj];else CPV[cnpj]=true;
  delete pendingCPV[cnpj];
  _pipelineCache=null;
  renderPreserveScroll();
  toast('Erro de rede: '+e.message,true);
 }
}

// ============================================================
// COMPUTE OKR
// ============================================================
// Compute complete metrics for a specific month
// applyCPV=true means include CP Validado overrides (use for "current" month)
function computeMonthMetrics(monthIdx,applyCPV){
 const m=DB.months[monthIdx];
 if(!m||!m.rows)return null;
 const rows=m.rows.map(dec);
 let both=0,cpS=0,cpV=0,tel=0,active=0,churn=0,inativo=0,total=rows.length;
 for(const r of rows){
  const ov=applyCPV&&CPV[r.c]===true;
  const cpE=r.cp||ov;
  if(r.tl)tel++;
  if(r.cp)cpS++;
  if(ov&&!r.cp)cpV++;
  if(cpE&&r.tl)both++;
  if(r.est==='Ativo'||r.est==='Recorrente')active++;
  if(r.est==='Churn')churn++;
  if(r.est==='Inativo')inativo++;
 }
 const target=getTargetForMonth(m.id);
 return{
  id:m.id,
  name:m.name,
  target,
  current:both,
  gap:Math.max(0,target-both),
  pct:Math.min(100,Math.round(both/target*1000)/10),
  cpS,cpV,tel,
  cpT:cpS+cpV,
  total,active,churn,inativo,
  // Coverage metrics
  cpCoverage:total>0?Math.round((cpS+cpV)/total*1000)/10:0,
  telCoverage:total>0?Math.round(tel/total*1000)/10:0,
  bothCoverage:total>0?Math.round(both/total*1000)/10:0
 };
}

function computeOKR(){
 const lastIdx=latI();
 const curKey=getCurrentQuarterKey();
 const curTarget=TARGETS[curKey]||DEFAULT_TARGET;
 if(lastIdx<0)return{target:curTarget,current:0,gap:curTarget,pct:0,cpS:0,cpV:0,tel:0,cpT:0};
 const m=computeMonthMetrics(lastIdx,true);
 return m||{target:curTarget,current:0,gap:curTarget,pct:0,cpS:0,cpV:0,tel:0,cpT:0};
}

// Get quarter info from month id (YYYY-MM) → {year, quarter, label}
function getQuarter(monthId){
 const parts=String(monthId).split('-');
 const yr=parseInt(parts[0])||0;
 const mo=parseInt(parts[1])||0;
 const q=Math.ceil(mo/3);
 return{year:yr,quarter:q,key:yr+'-Q'+q,label:'Q'+q+' '+yr};
}

// Aggregate metrics across months belonging to the same quarter
// Returns array of { key, label, months: [names], metrics: {aggregated} }
function computeQuarterlyMetrics(){
 const byQuarter={};
 DB.months.forEach((m,idx)=>{
  const q=getQuarter(m.id);
  if(!byQuarter[q.key])byQuarter[q.key]={...q,months:[],indices:[]};
  byQuarter[q.key].months.push(m.name);
  byQuarter[q.key].indices.push(idx);
 });
 // For each quarter, we take the LAST month of the quarter as the snapshot
 // (since OKR is cumulative, the last month represents the end-of-quarter state)
 const result=[];
 const sortedKeys=Object.keys(byQuarter).sort();
 for(const k of sortedKeys){
  const q=byQuarter[k];
  const lastIdx=q.indices[q.indices.length-1];
  // Apply CPV only for the most recent month overall
  const applyCPV=lastIdx===latI();
  const metrics=computeMonthMetrics(lastIdx,applyCPV);
  if(metrics){
   result.push({
    key:q.key,
    label:q.label,
    months:q.months,
    monthCount:q.months.length,
    metrics
   });
  }
 }
 return result;
}

// Dynamic pipeline: eligibility based on last 3 months avg DIAS >= 150
// Returns { cnpjs: Set, seg: {none, cp, tel}, cavDist: {cav: count} }
let _pipelineCache=null;let _pipelineCacheKey='';
function computePipeline(){
 if(!lat()||!lat().rows)return{cnpjs:new Set(),seg:{none:0,cp:0,tel:0},cavDist:{}};
 const cacheKey=DB.months.map(m=>m.id).join(',')+':'+Object.keys(CPV).sort().join(',');
 if(_pipelineCache&&_pipelineCacheKey===cacheKey)return _pipelineCache;
 
 // Use last 3 months (or less if fewer available)
 const recent=DB.months.slice(-3);
 const diasByCnpj={};
 for(const mo of recent){
  for(const r of mo.rows){
   const cn=r[0],dias=r[10];
   if(!diasByCnpj[cn])diasByCnpj[cn]=[];
   if(typeof dias==='number')diasByCnpj[cn].push(dias);
  }
 }
 // Eligible = avg >= 150
 const eligible=new Set();
 for(const cn in diasByCnpj){
  const vs=diasByCnpj[cn];
  if(vs.length&&vs.reduce((a,b)=>a+b,0)/vs.length>=150)eligible.add(cn);
 }
 // Pipeline: eligible AND doesn't have both (considering CPV)
 const latRows=lat().rows.map(dec);
 const pipeCnpjs=new Set();
 let sn=0,sc=0,st=0;
 const cavDist={};
 for(const r of latRows){
  if(!eligible.has(r.c))continue;
  const cpE=r.cp||CPV[r.c]===true;
  if(cpE&&r.tl)continue; // already has both
  pipeCnpjs.add(r.c);
  if(!cpE&&!r.tl)sn++;
  else if(cpE&&!r.tl)sc++;
  else if(r.tl&&!cpE)st++;
  if(r.cav&&r.cav!=='—')cavDist[r.cav]=(cavDist[r.cav]||0)+1;
 }
 const sortedCav=Object.fromEntries(Object.entries(cavDist).sort((a,b)=>b[1]-a[1]));
 _pipelineCache={cnpjs:pipeCnpjs,seg:{none:sn,cp:sc,tel:st},cavDist:sortedCav};
 _pipelineCacheKey=cacheKey;
 return _pipelineCache;
}

// ============================================================
// CSV EXPORT
// ============================================================
function expCSV(rows,fn){
 if(!rows.length)return;
 const hs=Object.keys(rows[0]);
 let csv=hs.join(';')+'\n';
 rows.forEach(r=>{csv+=hs.map(h=>String(r[h]??'').replace(/;/g,',')).join(';')+'\n'});
 const b=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
 const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=fn;a.click();
 toast('Exportado!');
}

function srt(arr,col,dir){return[...arr].sort((a,b)=>{let va=a[col],vb=b[col];if(va==null)va=dir==='asc'?Infinity:-Infinity;if(vb==null)vb=dir==='asc'?Infinity:-Infinity;if(typeof va==='string')return dir==='asc'?va.localeCompare(vb):vb.localeCompare(va);return dir==='asc'?va-vb:vb-va})}
function togSort(c){if(sortC===c)sortD=sortD==='desc'?'asc':'desc';else{sortC=c;sortD='desc'}pg=0;renderContent()}

function updateTabs(){
 document.querySelectorAll('.tabs .tab').forEach(el=>{
  const k=el.getAttribute('data-tab');
  if(k){el.classList.toggle('on',k===tab)}
 });
}

// ============================================================
// RENDER
// ============================================================
function render(){
 if(!lat())return;
 const okr=computeOKR();
 const ls=lat().stats||{total:lat().rows.length,active:0,cp:0,tel:0,both:0,cpOnly:0,telOnly:0};
 document.getElementById('app').innerHTML=`
 <div class="hdr an d1">
  <div class="hdr-l">
   <svg class="hdr-logo" viewBox="0 0 2267.74 413.11"><use href="#logo-px"/></svg>
   <div class="hdr-title">
    <p>Conteúdo Personalizado & Telemetria · ${lat().name}</p>
   </div>
  </div>
  <div class="hdr-r">
   <div class="user-badge">${currentUser.email}<span class="role-badge ${currentUser.role||'member'}">${currentUser.role==='admin'?'Admin':'Membro'}</span></div>
   <span class="sync-badge" id="sync-badge">Sincronizado</span>
   ${isAdmin()?'<button class="btn btn-o" onclick="showImportModal()">📂 Importar Mês</button><button class="btn btn-g" onclick="showTargetModal()">🎯 Ajustar Meta</button>':''}
   <button class="btn btn-p" onclick="expPipeline()">⬇ Pipeline</button>
   <button class="btn btn-b" onclick="expBoth()">⬇ Aderidos</button>
   <button class="btn" onclick="expBase()">⬇ Base</button>
   <button class="btn" onclick="logout()" title="Sair">⏻</button>
  </div>
 </div>
 <div class="hero an d2">
  <div class="hero-m">
   ${(()=>{
    const qp=computeQuarterProgress();
    if(!qp)return `<div class="lbl">Meta OKR — Clientes com Ambos os Produtos</div>
     <div class="bn"><span class="c">${okr.current}</span><span class="s">/</span><span class="t">${okr.target}</span></div>
     <div class="bar"><div class="bar-f" style="width:${okr.pct}%"></div></div>`;
    if(!qp.hasBaseline){
     // Primeiro trimestre da série — não há largada
     return `<div class="lbl">Meta OKR — Clientes com Ambos os Produtos</div>
      <div class="bn"><span class="c">${okr.current}</span><span class="s">/</span><span class="t">${okr.target}</span></div>
      <div class="bar"><div class="bar-f" style="width:${okr.pct}%"></div></div>
      <div class="qhero-firstq" style="margin-top:14px">📍 <strong>${qp.quarterLabel}</strong> — primeiro trimestre da série, sem largada anterior. A barra mostra o avanço absoluto contra a meta.</div>
      <div class="mt">
       <span>Progresso <strong>${okr.pct}%</strong></span>
       <span>Gap <strong>${okr.gap}</strong></span>
       <span>CP Sistema <strong>${okr.cpS}</strong></span>
       <span>CP Validado <strong style="color:var(--or)">${okr.cpV}</strong></span>
       <span>Telemetria <strong>${okr.tel}</strong></span>
      </div>`;
    }
    // Caso normal: trimestre com largada
    const dPos=qp.deltaNeeded>0?Math.min(100,(qp.baseline/qp.target)*100):0;
    return `<div class="qhero">
     <div class="qhero-main">
      <div class="qhero-tag"><span class="dotpulse"></span> Esforço do ${qp.quarterLabel} — em andamento</div>
      <div class="qhero-headline">Você precisa conquistar <strong>${qp.deltaNeeded} clientes</strong> neste trimestre para atingir a meta de <strong>${qp.target}</strong>.</div>
      <div class="qhero-big">
       <span class="qb-num">${qp.delta>=0?qp.delta:0}</span>
       <span class="qb-of">de</span>
       <span class="qb-need">${qp.deltaNeeded}</span>
       <span class="qb-suffix">conquistados no ${qp.quarterLabel}</span>
      </div>
      <div class="qhero-pct">
       <span class="qhero-pct-num">${qp.pctIncremental}%</span>
       <span class="qhero-pct-lbl">do esforço do trimestre concluído</span>
      </div>
      <div class="qhero-bar">
       <div class="qhero-bar-fill" style="width:${qp.pctIncremental}%"></div>
      </div>
      <div class="qhero-anchors">
       <span>Largada: ${qp.baseline} (${qp.startMonth||'—'})</span>
       <span class="qa-now">Agora: ${qp.current}</span>
       <span>Meta: ${qp.target}</span>
      </div>
     </div>
     <div class="qhero-side">
      <div class="qhero-side-lbl">Status absoluto</div>
      <div class="qhero-side-num">${qp.current}<span class="qsn-of">/</span>${qp.target}</div>
      <div class="qhero-side-pct">${qp.pctAbsolute}% da meta total</div>
      <div class="qhero-side-bar"><div class="qhero-side-bar-fill" style="width:${qp.pctAbsolute}%"></div></div>
      <div class="qhero-side-rem">
       <div class="qhero-side-rem-num">${qp.remaining}</div>
       <div class="qhero-side-rem-lbl">${qp.remaining===1?'cliente faltando':'clientes faltando'}<br>para fechar a meta</div>
      </div>
     </div>
    </div>
    <div class="mt" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--bd)">
     <span>CP Sistema <strong>${okr.cpS}</strong></span>
     <span>CP Validado <strong style="color:var(--or)">${okr.cpV}</strong></span>
     <span>Telemetria <strong>${okr.tel}</strong></span>
     <span>Total Base <strong>${fmt(ls.total)}</strong></span>
    </div>`;
   })()}
  </div>
  <div class="hero-r">
   <div class="sc g" onclick="openDrill('both')"><div class="lbl">Ambos (efetivo)</div><div class="v">${okr.current}</div><div class="su">Sistema + Validados</div></div>
   <div class="sc b" onclick="openDrill('cpSys')"><div class="lbl">CP Sistema</div><div class="v">${okr.cpS}</div><div class="su">Via planilha</div></div>
   <div class="sc o" onclick="openDrill('cpVal')"><div class="lbl">CP Validado</div><div class="v">${okr.cpV}</div><div class="su">Override manual</div></div>
   <div class="sc p" onclick="openDrill('tel')"><div class="lbl">Telemetria</div><div class="v">${okr.tel}</div><div class="su">${fmt(ls.total)} na base</div></div>
  </div>
 </div>
 <div class="legend an d3">
  <span style="font-size:.68rem;color:var(--tx3);font-weight:600">Legenda:</span>
  <div class="legend-item"><div class="legend-dot" style="background:var(--ac)"></div>CP ativo via sistema</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--or)"></div>CP validado (proposta aceita)</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--tx3)"></div>Sem CP</div>
  <div class="legend-item" style="margin-left:auto;font-size:.62rem;color:var(--tx3)">${isAdmin()?'💡 Clique nos cards acima para drilldown':'🔒 Modo visualização · alterações desabilitadas'}</div>
 </div>
 <div class="tabs an d3">
  ${[['overview','Visão Geral'],['pipeline','Pipeline Elegível'],['clients','Aderidos'],['base','Base Completa'],['new','Novos'],['history','Histórico']].map(([k,l])=>{
   let bd='';
   if(k==='pipeline')bd=computePipeline().cnpjs.size;
   if(k==='clients')bd=okr.current;
   if(k==='base')bd=ls.total;
   if(k==='history')bd=DB.months.length;
   return`<button class="tab ${tab===k?'on':''}" data-tab="${k}" onclick="drilldown=null;tab='${k}';pg=0;searchVal='';updateTabs();renderContent()">${l}${bd?`<span class="bd">${bd}</span>`:''}</button>`
  }).join('')}
 </div>
 <div id="ct"></div>`;
 renderContent();
 enhanceWorkspace();
}

function renderContent(){
 const ct=document.getElementById('ct');
 if(!ct)return;
 if(drilldown)return renderDrilldown(ct);
 if(tab==='overview')renderStrategicOverview(ct);
 else if(tab==='pipeline')renderPipeline(ct);
 else if(tab==='clients')renderClients(ct);
 else if(tab==='base')renderBase(ct);
 else if(tab==='new')renderNew(ct);
 else if(tab==='history')renderHistory(ct);
 else if(tab==='methodology')renderMethodology(ct);
 queueMicrotask(makeClientRowsInteractive);
}

function openDrill(type){drilldown={type};pg=0;searchVal='';renderContent()}

function renderDrilldown(ct){
 const d=drilldown;
 const rows=lat().rows.map(dec);
 let title,desc,filtered;
 if(d.type==='both'){title='Clientes com Ambos os Produtos (Efetivo)';desc='Clientes onde (CP Sistema = Sim OU CP Validado = Sim) E Telemetria = Sim';filtered=rows.filter(r=>(r.cp||CPV[r.c])&&r.tl)}
 else if(d.type==='cpSys'){title='Clientes com CP via Sistema';desc='Conteúdo Personalizado ativo conforme última planilha importada';filtered=rows.filter(r=>r.cp)}
 else if(d.type==='cpVal'){title='Clientes com CP Validado Manualmente';desc='Proposta aceita — CP marcado manualmente pelo time';filtered=rows.filter(r=>CPV[r.c]===true&&!r.cp)}
 else if(d.type==='tel'){title='Clientes com Telemetria';desc='Telemetria ativa conforme última planilha importada';filtered=rows.filter(r=>r.tl)}
 if(searchVal){const s=searchVal.toLowerCase();filtered=filtered.filter(r=>r.n.toLowerCase().includes(s)||r.c.includes(s)||r.cav.toLowerCase().includes(s)||r.ger.toLowerCase().includes(s)||r.ana.toLowerCase().includes(s))}
 filtered=srt(filtered,sortC,sortD);
 const total=filtered.length,pages=Math.ceil(total/PP);if(pg>=pages)pg=Math.max(0,pages-1);
 const sl=filtered.slice(pg*PP,(pg+1)*PP);
 ct.innerHTML=`
 <button class="back-btn" onclick="drilldown=null;renderContent()">← Voltar</button>
 <div class="stit">${title}</div>
 <div class="sdesc">${desc} — ${total} clientes</div>
 <div class="tc">
  <input class="sb" id="srch" placeholder="Buscar nome, CNPJ, cavaleiro, gerente, analista..." value="${searchVal}">
  <button class="btn" onclick="expDrill()">⬇ Exportar</button>
 </div>
 <div class="tw"><table><thead><tr>
  <th onclick="togSort('n')">Transportadora</th><th onclick="togSort('dias')">Dias ↕</th>
  <th>CP Sist.</th><th>CP Valid.</th><th>TEL</th>
  <th onclick="togSort('cls')">Classif.</th><th onclick="togSort('cav')">Cavaleiro</th><th onclick="togSort('ger')">Gerente</th><th>Analista</th><th>Tipo</th><th>Estado</th><th onclick="togSort('ct')">Contratos</th>
 </tr></thead><tbody>
 ${sl.map(r=>`<tr>
  <td><strong>${r.n}</strong><br><span style="color:var(--tx3);font-size:.63rem;font-family:'DM Mono',monospace">${r.c}</span></td>
  <td>${fmtD(r.dias)}</td><td>${tagYN(r.cp)}</td>
  <td>${cpvTogHTML(r.c,r.cp)}</td>
  <td>${tagYN(r.tl)}</td><td>${clsB(r.cls)}</td>
  <td style="font-size:.68rem">${r.cav}</td><td style="font-size:.68rem">${r.ger}</td><td style="font-size:.68rem">${r.ana}</td>
  <td style="font-size:.68rem">${r.tipo}</td><td><span class="tg ${r.est==='Recorrente'||r.est==='Ativo'?'y':r.est==='Churn'?'op':'n'}">${r.est}</span></td>
  <td>${fmt(r.ct)}</td></tr>`).join('')}
 </tbody></table></div>
 ${pagH(total,pages)}`;
 bindSearch();
}

function expDrill(){
 const rows=lat().rows.map(dec);
 let f;const d=drilldown;
 if(d.type==='both')f=rows.filter(r=>(r.cp||CPV[r.c])&&r.tl);
 else if(d.type==='cpSys')f=rows.filter(r=>r.cp);
 else if(d.type==='cpVal')f=rows.filter(r=>CPV[r.c]&&!r.cp);
 else f=rows.filter(r=>r.tl);
 expCSV(f.map(r=>({Transportadora:r.n,CNPJ:r.c,'CP Sistema':r.cp?'Sim':'Não','CP Validado':CPV[r.c]?'Sim':'Não',Telemetria:r.tl?'Sim':'Não',Cavaleiro:r.cav,Gerente:r.ger,Analista:r.ana,Tipo:r.tipo,Estado:r.est,Classificação:CLS_L[r.cls],'Dias Contrato':r.dias,Contratos:r.ct})),`detalhe_${d.type}.csv`);
}

function bindSearch(){
 const el=document.getElementById('srch');
 if(!el)return;
 el.removeEventListener('input',handleSearch);
 el.addEventListener('input',handleSearch);
}
function handleSearch(e){
 searchVal=e.target.value;pg=0;
 const ct=document.getElementById('ct');
 if(drilldown)renderDrilldown(ct);else renderContent();
 const el=document.getElementById('srch');
 if(el){el.focus();el.setSelectionRange(searchVal.length,searchVal.length)}
}

function renderOverview(ct){
 ct.innerHTML=`
 <div class="stit">Evolução Mensal</div>
 <div class="sdesc">Acompanhamento ao longo dos ${DB.months.length} meses importados</div>
 <div class="cg">
  <div class="cc"><h3>Evolução de Adoção</h3><div class="cw"><canvas id="ch1"></canvas></div></div>
  <div class="cc"><h3>Distribuição Atual</h3><div class="cw"><canvas id="ch2"></canvas></div></div>
 </div>
 <div class="cg cg-full">
  <div class="cc"><h3>Projeção de Atingimento da Meta</h3><div class="cw cw-tall"><canvas id="ch4"></canvas></div></div>
 </div>`;
 renderCharts();
}

function renderPipeline(ct){
 const pipe=computePipeline();
 const seg=pipe.seg;
 const allR=lat().rows.map(dec).filter(r=>pipe.cnpjs.has(r.c));
 let data=[...allR];
 if(pipeF==='none')data=data.filter(r=>!r.cp&&!r.tl&&!CPV[r.c]);
 if(pipeF==='cponly')data=data.filter(r=>(r.cp||CPV[r.c])&&!r.tl);
 if(pipeF==='telonly')data=data.filter(r=>r.tl&&!r.cp&&!CPV[r.c]);
 if(searchVal){const s=searchVal.toLowerCase();data=data.filter(r=>r.n.toLowerCase().includes(s)||r.c.includes(s)||r.cav.toLowerCase().includes(s)||r.ger.toLowerCase().includes(s))}
 data=srt(data,sortC,sortD);
 const total=data.length,pages=Math.ceil(total/PP);if(pg>=pages)pg=Math.max(0,pages-1);
 const sl=data.slice(pg*PP,(pg+1)*PP);
 const maxD=Math.max(...allR.map(r=>r.dias),1);
 ct.innerHTML=`
 <div class="stit">Pipeline de Conversão — Elegíveis CP</div>
 <div class="sdesc">Clientes com média ≥ 150 dias agenciados nos últimos 3 meses. Clique nos cards abaixo para filtrar.</div>
 <div class="pg">
  <div class="pc a ${pipeF==='none'?'on':''}" onclick="pipeF='${pipeF==='none'?'all':'none'}';pg=0;renderContent()"><div class="pi">🎯</div><div class="pv">${seg.none}</div><div class="pl">Sem nenhum produto</div></div>
  <div class="pc b ${pipeF==='cponly'?'on':''}" onclick="pipeF='${pipeF==='cponly'?'all':'cponly'}';pg=0;renderContent()"><div class="pi">📋</div><div class="pv">${seg.cp}</div><div class="pl">Só CP (falta TEL)</div></div>
  <div class="pc c ${pipeF==='telonly'?'on':''}" onclick="pipeF='${pipeF==='telonly'?'all':'telonly'}';pg=0;renderContent()"><div class="pi">📡</div><div class="pv">${seg.tel}</div><div class="pl">Só TEL (falta CP)</div></div>
 </div>
 <div class="tc">
  <input class="sb" id="srch" placeholder="Buscar..." value="${searchVal}">
  <div class="fps">
   ${[['all','Todos'],['none','Sem Produtos','wo'],['cponly','Só CP','bl'],['telonly','Só TEL','pu']].map(([k,l,x])=>`<button class="pill ${x||''} ${pipeF===k?'on':''}" onclick="pipeF='${k}';pg=0;renderContent()">${l}</button>`).join('')}
  </div>
 </div>
 <div class="tw"><table><thead><tr>
  <th onclick="togSort('n')">Transportadora</th><th onclick="togSort('dias')">Dias ↕</th>
  <th>CP Sist.</th><th>CP Valid.</th><th>TEL</th><th onclick="togSort('cls')">Classif.</th>
  <th onclick="togSort('cav')">Cavaleiro</th><th onclick="togSort('ger')">Gerente</th><th>Analista</th>
  <th onclick="togSort('ct')">Contratos</th><th>Ação</th>
 </tr></thead><tbody>
 ${sl.map(r=>{const cpE=r.cp||CPV[r.c];return`<tr>
  <td><strong>${r.n}</strong><br><span style="color:var(--tx3);font-size:.63rem;font-family:'DM Mono',monospace">${r.c}</span></td>
  <td>${fmtD(r.dias)}<div class="db"><div class="db-f" style="width:${pct(r.dias,maxD)}%"></div></div></td>
  <td>${tagYN(r.cp)}</td>
  <td>${cpvTogHTML(r.c,r.cp)}</td>
  <td>${tagYN(r.tl)}</td><td>${clsB(r.cls)}</td>
  <td style="font-size:.68rem">${r.cav}</td><td style="font-size:.68rem">${r.ger}</td><td style="font-size:.68rem">${r.ana}</td>
  <td>${fmt(r.ct)}</td>
  <td><span class="tg ${cpE&&r.tl?'y':'op'}">${cpE&&r.tl?'✓':(!cpE&&!r.tl?'Ambos':(!cpE?'+CP':'+TEL'))}</span></td>
 </tr>`}).join('')}
 </tbody></table></div>
 ${pagH(total,pages)}`;
 bindSearch();
}

function renderClients(ct){
 let data=lat().rows.map(dec).filter(r=>(r.cp||CPV[r.c])&&r.tl);
 if(searchVal){const s=searchVal.toLowerCase();data=data.filter(r=>r.n.toLowerCase().includes(s)||r.c.includes(s))}
 data=srt(data,sortC,sortD);
 const total=data.length,pages=Math.ceil(total/PP);if(pg>=pages)pg=Math.max(0,pages-1);
 const sl=data.slice(pg*PP,(pg+1)*PP);
 ct.innerHTML=`
 <div class="stit">Clientes Aderidos — Ambos os Produtos</div>
 <div class="sdesc">${total} clientes com CP (sistema ou validado) + Telemetria</div>
 <div class="tc"><input class="sb" id="srch" placeholder="Buscar..." value="${searchVal}"></div>
 <div class="tw"><table><thead><tr>
  <th onclick="togSort('n')">Transportadora</th><th onclick="togSort('dias')">Dias ↕</th>
  <th>CP Sist.</th><th>CP Valid.</th><th onclick="togSort('cls')">Classif.</th>
  <th onclick="togSort('cav')">Cavaleiro</th><th onclick="togSort('ger')">Gerente</th><th>Analista</th><th>Tipo</th><th>Estado</th><th onclick="togSort('ct')">Contratos</th>
 </tr></thead><tbody>
 ${sl.map(r=>`<tr>
  <td><strong>${r.n}</strong><br><span style="color:var(--tx3);font-size:.63rem;font-family:'DM Mono',monospace">${r.c}</span></td>
  <td>${fmtD(r.dias)}</td><td>${tagYN(r.cp)}</td>
  <td>${cpvTogHTML(r.c,r.cp)}</td>
  <td>${clsB(r.cls)}</td><td style="font-size:.68rem">${r.cav}</td><td style="font-size:.68rem">${r.ger}</td><td style="font-size:.68rem">${r.ana}</td>
  <td style="font-size:.68rem">${r.tipo}</td><td><span class="tg y">${r.est}</span></td><td>${fmt(r.ct)}</td>
 </tr>`).join('')}</tbody></table></div>
 ${pagH(total,pages)}`;
 bindSearch();
}

function renderBase(ct){
 if(viewMi<0||viewMi>=DB.months.length)viewMi=latI();
 const mo=DB.months[viewMi];
 let data=mo.rows.map(dec);
 if(baseF==='active')data=data.filter(r=>r.est==='Ativo'||r.est==='Recorrente');
 if(baseF==='churn')data=data.filter(r=>r.est==='Churn');
 if(baseF==='inativo')data=data.filter(r=>r.est==='Inativo');
 if(baseF==='cp')data=data.filter(r=>r.cp||CPV[r.c]);
 if(baseF==='tl')data=data.filter(r=>r.tl);
 if(baseF==='both')data=data.filter(r=>(r.cp||CPV[r.c])&&r.tl);
 if(searchVal){const s=searchVal.toLowerCase();data=data.filter(r=>r.n.toLowerCase().includes(s)||r.c.includes(s)||r.cav.toLowerCase().includes(s)||r.ger.toLowerCase().includes(s)||r.ana.toLowerCase().includes(s))}
 data=srt(data,sortC,sortD);
 const total=data.length,pages=Math.ceil(total/PP);if(pg>=pages)pg=Math.max(0,pages-1);
 const sl=data.slice(pg*PP,(pg+1)*PP);
 ct.innerHTML=`
 <div class="stit">Base Completa — ${mo.name}</div>
 <div class="sdesc">Todos os ${fmt(mo.rows.length)} clientes</div>
 <div class="tc">
  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
   <input class="sb" id="srch" placeholder="Buscar nome, CNPJ, cavaleiro, gerente, analista..." value="${searchVal}">
   <div class="ms">${DB.months.map((m,i)=>`<button class="mb ${viewMi===i?'on':''}" onclick="viewMi=${i};pg=0;renderContent()">${m.name.split(' ')[0]}</button>`).join('')}</div>
  </div>
  <button class="btn" onclick="expBase()" style="font-size:.68rem">⬇ Exportar</button>
 </div>
 <div class="fps" style="margin-bottom:8px">
  ${[['all','Todos'],['active','Ativos/Recorrentes'],['churn','Churn','wo'],['inativo','Inativos'],['cp','Com CP','bl'],['tl','Com TEL','pu'],['both','Ambos','cy']].map(([k,l,x])=>`<button class="pill ${x||''} ${baseF===k?'on':''}" onclick="baseF='${k}';pg=0;renderContent()">${l}</button>`).join('')}
 </div>
 <div class="tw"><table><thead><tr>
  <th onclick="togSort('n')">Transportadora</th><th>CP Sist.</th><th>CP Valid.</th><th>TEL</th>
  <th onclick="togSort('cav')">Cavaleiro</th><th onclick="togSort('ger')">Gerente</th><th>Analista</th><th>Tipo</th>
  <th onclick="togSort('est')">Estado</th><th onclick="togSort('cls')">Classif.</th><th onclick="togSort('dias')">Dias ↕</th><th onclick="togSort('ct')">Contratos</th>
 </tr></thead><tbody>
 ${sl.map(r=>`<tr>
  <td><strong>${r.n}</strong><br><span style="color:var(--tx3);font-size:.63rem;font-family:'DM Mono',monospace">${r.c}</span></td>
  <td>${tagYN(r.cp)}</td>
  <td>${cpvTogHTML(r.c,r.cp)}</td>
  <td>${tagYN(r.tl)}</td>
  <td style="font-size:.68rem">${r.cav}</td><td style="font-size:.68rem">${r.ger}</td><td style="font-size:.68rem">${r.ana}</td>
  <td style="font-size:.68rem">${r.tipo}</td>
  <td><span class="tg ${r.est==='Recorrente'||r.est==='Ativo'?'y':r.est==='Churn'?'op':'n'}">${r.est}</span></td>
  <td>${clsB(r.cls)}</td><td>${fmtD(r.dias)}</td><td>${fmt(r.ct)}</td>
 </tr>`).join('')}</tbody></table></div>
 ${pagH(total,pages)}`;
 bindSearch();
}

function renderNew(ct){
 if(DB.months.length<2){ct.innerHTML='<div class="sdesc">Necessário ao menos 2 meses para identificar novos clientes.</div>';return}
 const prev=new Set();for(let i=0;i<DB.months.length-1;i++)DB.months[i].rows.forEach(r=>prev.add(r[0]));
 let data=lat().rows.map(dec).filter(r=>!prev.has(r.c)&&(r.est==='Ativo'||r.est==='Recorrente'));
 if(searchVal){const s=searchVal.toLowerCase();data=data.filter(r=>r.n.toLowerCase().includes(s)||r.c.includes(s))}
 data=srt(data,sortC,sortD);
 const total=data.length,pages=Math.ceil(total/PP);if(pg>=pages)pg=Math.max(0,pages-1);
 const sl=data.slice(pg*PP,(pg+1)*PP);
 ct.innerHTML=`
 <div class="stit">Novos Clientes em Observação</div>
 <div class="sdesc">Entraram no último mês sem histórico anterior — ${total} novos ativos</div>
 <div class="tc"><input class="sb" id="srch" placeholder="Buscar..." value="${searchVal}"></div>
 <div class="tw"><table><thead><tr>
  <th onclick="togSort('n')">Transportadora</th><th onclick="togSort('dias')">Dias ↕</th><th>Projeção</th>
  <th>CP</th><th>CP Valid.</th><th>TEL</th><th onclick="togSort('cls')">Classif.</th>
  <th onclick="togSort('cav')">Cavaleiro</th><th onclick="togSort('ger')">Gerente</th><th>Analista</th><th onclick="togSort('ct')">Contratos</th>
 </tr></thead><tbody>
 ${sl.map(r=>`<tr>
  <td><strong>${r.n}</strong><br><span style="color:var(--tx3);font-size:.63rem;font-family:'DM Mono',monospace">${r.c}</span></td>
  <td>${fmtD(r.dias)}</td><td><span class="tg ${r.dias>=150?'y':'nw'}">${r.dias>=150?'Provável':'Acompanhar'}</span></td>
  <td>${tagYN(r.cp)}</td>
  <td>${cpvTogHTML(r.c,r.cp)}</td>
  <td>${tagYN(r.tl)}</td><td>${clsB(r.cls)}</td>
  <td style="font-size:.68rem">${r.cav}</td><td style="font-size:.68rem">${r.ger}</td><td style="font-size:.68rem">${r.ana}</td>
  <td>${fmt(r.ct)}</td></tr>`).join('')}
 </tbody></table></div>
 ${pagH(total,pages)}`;
 bindSearch();
}

function renderHistory(ct){
 // Compute metrics for each month
 const monthMetrics=DB.months.map((m,idx)=>computeMonthMetrics(idx,idx===latI()));
 // Pre-compute baseline for each month (start-of-quarter snapshot)
 const monthBaselines=DB.months.map(m=>{
  const parts=String(m.id).split('-');
  const yr=parseInt(parts[0])||0;
  const mo=parseInt(parts[1])||0;
  const q=Math.ceil(mo/3);
  return getBaselineForQuarter(yr,q);
 });
 // Compute quarterly aggregation
 const quarters=computeQuarterlyMetrics();
 // Quarter-over-quarter comparison (needs 2+ quarters)
 let qoqHTML='';
 if(quarters.length>=2){
  const rows=[];
  for(let i=1;i<quarters.length;i++){
   const cur=quarters[i],prev=quarters[i-1];
   const cm=cur.metrics,pm=prev.metrics;
   rows.push({
    label:prev.label+' → '+cur.label,
    both:{from:pm.current,to:cm.current,delta:cm.current-pm.current},
    pct:{from:pm.pct,to:cm.pct,delta:Math.round((cm.pct-pm.pct)*10)/10},
    cpS:{from:pm.cpS,to:cm.cpS,delta:cm.cpS-pm.cpS},
    cpV:{from:pm.cpV,to:cm.cpV,delta:cm.cpV-pm.cpV},
    tel:{from:pm.tel,to:cm.tel,delta:cm.tel-pm.tel},
    active:{from:pm.active,to:cm.active,delta:cm.active-pm.active},
    churn:{from:pm.churn,to:cm.churn,delta:cm.churn-pm.churn}
   });
  }
  const fmtDelta=(d,goodUp)=>{
   if(d===0)return `<span class="delta zero">—</span>`;
   const isPositive=d>0;
   const isGood=goodUp?isPositive:!isPositive;
   const cls=isGood?'up':'down';
   const arrow=isPositive?'▲':'▼';
   return `<span class="delta ${cls}">${arrow} ${isPositive?'+':''}${d}</span>`;
  };
  qoqHTML=`
  <div class="stit" style="margin-top:26px">Comparativo Trimestral</div>
  <div class="sdesc">Evolução de métricas-chave entre trimestres — valores "de → para" e variação</div>
  <div class="qoq-wrap">
   <table class="qoq-table">
    <thead>
     <tr>
      <th>Transição</th>
      <th>Ambos (OKR)</th>
      <th>% Meta</th>
      <th>CP Sistema</th>
      <th>CP Validado</th>
      <th>Telemetria</th>
      <th>Ativos</th>
      <th>Churn</th>
     </tr>
    </thead>
    <tbody>
     ${rows.map(r=>`<tr>
      <td class="qoq-label">${r.label}</td>
      <td><div class="qoq-val">${r.both.from} → <strong>${r.both.to}</strong></div>${fmtDelta(r.both.delta,true)}</td>
      <td><div class="qoq-val">${r.pct.from}% → <strong>${r.pct.to}%</strong></div>${fmtDelta(r.pct.delta,true)}</td>
      <td><div class="qoq-val">${r.cpS.from} → <strong>${r.cpS.to}</strong></div>${fmtDelta(r.cpS.delta,true)}</td>
      <td><div class="qoq-val">${r.cpV.from} → <strong>${r.cpV.to}</strong></div>${fmtDelta(r.cpV.delta,true)}</td>
      <td><div class="qoq-val">${r.tel.from} → <strong>${r.tel.to}</strong></div>${fmtDelta(r.tel.delta,true)}</td>
      <td><div class="qoq-val">${r.active.from} → <strong>${r.active.to}</strong></div>${fmtDelta(r.active.delta,true)}</td>
      <td><div class="qoq-val">${r.churn.from} → <strong>${r.churn.to}</strong></div>${fmtDelta(r.churn.delta,false)}</td>
     </tr>`).join('')}
    </tbody>
   </table>
  </div>
  <div class="qoq-note">💡 <strong>Nota:</strong> para cada trimestre, usamos o último mês como snapshot (estado de fechamento). Setas verdes indicam evolução positiva; vermelhas, negativa. Para "Churn", menor é melhor.</div>`;
 }else if(DB.months.length>=2){
  qoqHTML=`<div class="qoq-note" style="margin-top:20px">📊 O comparativo trimestral aparecerá quando você tiver meses em pelo menos 2 trimestres diferentes (ex: Jan/Fev/Mar + Abr).</div>`;
 }
 
 ct.innerHTML=`
 <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px">
  <div>
   <div class="stit" style="margin-bottom:0">Histórico de Períodos</div>
   <div class="sdesc" style="margin-bottom:0">Snapshot detalhado de cada mês importado. Clique em um card para ver o breakdown completo.</div>
  </div>
  <button class="btn btn-p" onclick="expHistoryReport()" style="white-space:nowrap">⬇ Exportar Relatório Completo</button>
 </div>
 <div class="hist-cards" style="margin-top:16px">${DB.months.map((m,i)=>{
  const met=monthMetrics[i];
  if(!met)return '';
  const q=getQuarter(m.id);
  return`
  <div class="hist-card ${histMi===i?'active':''}" onclick="histMi=${i};renderContent()">
   <div class="hist-head">
    <h4>${m.name}</h4>
    <span class="hist-q">${q.label}</span>
   </div>
   <div class="hist-okr">
    <div class="hist-okr-big">${met.current}<span class="hist-okr-sep">/</span><span class="hist-okr-tgt">${met.target}</span></div>
    <div class="hist-okr-bar"><div class="hist-okr-fill" style="width:${met.pct}%"></div></div>
    <div class="hist-okr-pct">${met.pct}% · gap ${met.gap}${(()=>{
     const bl=monthBaselines[i];
     if(!bl.hasBaseline)return '';
     const d=met.current-bl.baseline;
     const sign=d>0?'+':'';
     const cls=d>0?'qd-up':(d<0?'qd-dn':'qd-eq');
     return ` · <span class="qd ${cls}">${sign}${d} no Q</span>`;
    })()}</div>
   </div>
   <div class="hist-mets">
    <div class="hist-met"><span class="hm-k">CP Sist.</span><span class="hm-v">${met.cpS}</span></div>
    <div class="hist-met"><span class="hm-k">CP Valid.</span><span class="hm-v" style="color:var(--or)">${met.cpV}</span></div>
    <div class="hist-met"><span class="hm-k">Telemetria</span><span class="hm-v" style="color:var(--pu)">${met.tel}</span></div>
    <div class="hist-met"><span class="hm-k">Ativos</span><span class="hm-v">${met.active}</span></div>
   </div>
   ${DB.months.length>1&&isAdmin()?`<span class="hist-del" onclick="event.stopPropagation();delPeriod('${m.id}')">Remover</span>`:''}
  </div>`}).join('')}</div>
 ${histMi>=0&&histMi<DB.months.length?renderHistDetail():'<div class="sdesc" style="margin-top:14px">👆 Clique em um card acima para ver o detalhamento completo do mês.</div>'}
 ${qoqHTML}
 ${DB.months.length>=2?`<div class="cc" style="margin-top:20px"><h3>Evolução Mensal (Visão Geral)</h3><div class="cw"><canvas id="chH"></canvas></div></div>
 <script>setTimeout(()=>{const x=document.getElementById('chH');if(!x)return;
 new Chart(x,{type:'bar',data:{labels:${JSON.stringify(monthMetrics.map(m=>m?m.name.split(' ')[0]:'—'))},datasets:[
 {label:'Ambos (OKR)',data:${JSON.stringify(monthMetrics.map(m=>m?m.current:0))},backgroundColor:'#9d5fe0',borderRadius:4},
 {label:'CP Validado',data:${JSON.stringify(monthMetrics.map(m=>m?m.cpV:0))},backgroundColor:'#f97316',borderRadius:4},
 {label:'Telemetria',data:${JSON.stringify(monthMetrics.map(m=>m?m.tel:0))},backgroundColor:'#c084fc',borderRadius:4}
 ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,padding:12}}},scales:{y:{beginAtZero:true,grid:{color:'rgba(44,37,64,.4)'}},x:{grid:{display:false}}}}})},50)<\/script>`:''}`;
}

function renderHistDetail(){
 const m=DB.months[histMi];
 const met=computeMonthMetrics(histMi,histMi===latI());
 if(!met)return '';
 const rows=m.rows.map(dec);
 const est={};rows.forEach(r=>{est[r.est]=(est[r.est]||0)+1});
 const cb={};rows.filter(r=>(r.cp||(histMi===latI()&&CPV[r.c]))&&r.tl).forEach(r=>{cb[r.cav]=(cb[r.cav]||0)+1});
 // Compute Q incremental block for this month
 const parts=String(m.id).split('-');
 const yr=parseInt(parts[0])||0;
 const mo=parseInt(parts[1])||0;
 const qNum=Math.ceil(mo/3);
 const bl=getBaselineForQuarter(yr,qNum);
 const qDelta=met.current-bl.baseline;
 const qNeeded=Math.max(0,met.target-bl.baseline);
 const qPct=qNeeded>0?Math.min(100,Math.round((qDelta/qNeeded)*1000)/10):(qDelta>=0?100:0);
 return`<div class="cc" style="margin-top:14px;margin-bottom:14px">
  <h3>${m.name} — Detalhamento Completo</h3>
  <div class="hist-detail-grid">
   <div class="hd-block">
    <div class="hd-title">Atingimento Absoluto</div>
    <div class="hd-big" style="color:var(--ac)">${met.current}<span style="color:var(--tx3);font-size:1rem"> / ${met.target}</span></div>
    <div class="hd-sub">${met.pct}% da meta · gap de ${met.gap} clientes</div>
   </div>
   ${bl.hasBaseline?`<div class="hd-block" style="border-left:2px solid var(--ac)">
    <div class="hd-title">Esforço do Q${qNum} (incremental)</div>
    <div class="hd-big" style="color:var(--ac)">${qDelta>=0?'+':''}${qDelta}<span style="color:var(--tx3);font-size:1rem"> de ${qNeeded}</span></div>
    <div class="hd-sub">${qPct}% do esforço do trimestre · largada em ${bl.baseline} (${bl.startMonth})</div>
   </div>`:`<div class="hd-block">
    <div class="hd-title">Esforço do Trimestre</div>
    <div class="hd-sub" style="margin-top:14px">📍 Sem largada anterior — primeiro trimestre da série. Use o atingimento absoluto.</div>
   </div>`}
   <div class="hd-block">
    <div class="hd-title">Breakdown de Produtos</div>
    <div class="hd-row"><span>CP via Sistema</span><strong>${met.cpS}</strong></div>
    <div class="hd-row"><span>CP Validado (manual)</span><strong style="color:var(--or)">${met.cpV}</strong></div>
    <div class="hd-row"><span>CP Total (Sist + Valid)</span><strong>${met.cpT}</strong></div>
    <div class="hd-row"><span>Telemetria</span><strong style="color:var(--pu)">${met.tel}</strong></div>
   </div>
   <div class="hd-block">
    <div class="hd-title">Base de Clientes</div>
    <div class="hd-row"><span>Total no mês</span><strong>${fmt(met.total)}</strong></div>
    <div class="hd-row"><span>Ativos/Recorrentes</span><strong style="color:var(--gr)">${met.active}</strong></div>
    <div class="hd-row"><span>Em Churn</span><strong style="color:var(--wm)">${met.churn}</strong></div>
    <div class="hd-row"><span>Inativos</span><strong>${met.inativo}</strong></div>
   </div>
   <div class="hd-block">
    <div class="hd-title">Cobertura (%)</div>
    <div class="hd-row"><span>CP / Total</span><strong>${met.cpCoverage}%</strong></div>
    <div class="hd-row"><span>Telemetria / Total</span><strong>${met.telCoverage}%</strong></div>
    <div class="hd-row"><span>Ambos / Total</span><strong>${met.bothCoverage}%</strong></div>
   </div>
  </div>
  <div style="margin-top:16px">
   <div class="hd-title">Distribuição por Estado</div>
   <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:10px">
    ${Object.entries(est).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div style="text-align:center;background:var(--sf2);padding:10px;border-radius:var(--rx)"><div style="font-size:1.2rem;font-weight:700;color:var(--ac)">${v}</div><div style="font-size:.66rem;color:var(--tx3);margin-top:2px">${k}</div></div>`).join('')}
   </div>
  </div>
  ${Object.keys(cb).length?`<div style="margin-top:16px">
   <div class="hd-title">Ambos por Cavaleiro</div>
   <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${Object.entries(cb).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<span class="tg y">${k}: ${v}</span>`).join('')}</div>
  </div>`:''}
 </div>`;
}
async function delPeriod(id){
 if(!isAdmin()){toast('Apenas administradores podem remover períodos',true);return}
 if(DB.months.length<=1){toast('Mínimo 1 período',true);return}
 if(!confirm('Remover este período?'))return;
 try{
  const r=await apiCall('delete_month',{id,user:currentUser.email});
  if(r.ok){
   DB.months=DB.months.filter(m=>m.id!==id);
   histMi=-1;viewMi=latI();
   render();toast('Removido');
  }else toast('Erro: '+r.error,true);
 }catch(e){toast('Erro: '+e.message,true)}
}

function pagH(t,p){
 if(p<=1)return`<div class="pag"><span>${t} registros</span><span></span></div>`;
 return`<div class="pag"><span>${t} reg · Pág ${pg+1}/${p}</span><div class="pag-btns">
 <button class="pag-btn" onclick="pg=0;renderContent()" ${pg===0?'disabled':''}>⟪</button>
 <button class="pag-btn" onclick="pg--;renderContent()" ${pg===0?'disabled':''}>◂</button>
 <button class="pag-btn" onclick="pg++;renderContent()" ${pg>=p-1?'disabled':''}>▸</button>
 <button class="pag-btn" onclick="pg=${p-1};renderContent()" ${pg>=p-1?'disabled':''}>⟫</button></div></div>`}

function renderCharts(){
 const ms=DB.months.map(m=>({name:m.name.split(' ')[0],id:m.id,...(m.stats||{})}));
 Chart.defaults.color='#a59dc0';Chart.defaults.borderColor='rgba(44,37,64,.6)';Chart.defaults.font.family="'Instrument Sans',system-ui";Chart.defaults.font.size=11;
 
 // Compute LIVE values for the latest month (considering CP Validado overrides)
 // This keeps all charts consistent with the hero OKR number
 const latRows=lat().rows.map(dec);
 let ambos=0,soCp=0,soTel=0;
 for(const r of latRows){
  const cpE=r.cp||CPV[r.c]===true;
  if(cpE&&r.tl)ambos++;
  else if(cpE&&!r.tl)soCp++;
  else if(!cpE&&r.tl)soTel++;
 }
 const totalDist=ambos+soCp+soTel;
 
 // CH1: Evolução de Adoção — latest month uses LIVE values
 const ch1Ambos=ms.map((m,idx)=>idx===ms.length-1?ambos:(m.both||0));
 const ch1Cp=ms.map((m,idx)=>idx===ms.length-1?soCp:(m.cpOnly||0));
 const ch1Tel=ms.map((m,idx)=>idx===ms.length-1?soTel:(m.telOnly||0));
 new Chart(document.getElementById('ch1'),{type:'line',data:{labels:ms.map(x=>x.name),datasets:[
  {label:'Ambos',data:ch1Ambos,borderColor:'#9d5fe0',backgroundColor:'rgba(157,95,224,.08)',fill:true,tension:.3,pointRadius:4,borderWidth:2.5,pointBackgroundColor:'#9d5fe0'},
  {label:'Só CP',data:ch1Cp,borderColor:'#4d8fff',backgroundColor:'rgba(77,143,255,.06)',fill:true,tension:.3,pointRadius:3,borderWidth:2},
  {label:'Só TEL',data:ch1Tel,borderColor:'#c084fc',backgroundColor:'rgba(192,132,252,.06)',fill:true,tension:.3,pointRadius:3,borderWidth:2}
 ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,padding:12}}},scales:{y:{beginAtZero:true,grid:{color:'rgba(44,37,64,.4)'}}}}});
 
 // CH2: Distribuição Atual
 new Chart(document.getElementById('ch2'),{type:'doughnut',data:{labels:['Ambos (meta)','Só CP — falta TEL','Só TEL — falta CP'],datasets:[{data:[ambos,soCp,soTel],backgroundColor:['#9d5fe0','#4d8fff','#c084fc'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{position:'bottom',labels:{usePointStyle:true,padding:10,font:{size:10}}},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed;const p=totalDist>0?Math.round(v/totalDist*100):0;return ctx.label+': '+v+' clientes ('+p+'% do grupo)'}}}}}});
 
 // CH4: Projeção de Atingimento com nomes reais dos próximos meses
 // Usa valores corretos de "Ambos" (considera CP Validado no mês atual)
 if(ms.length>=2){
  // Compute real "Ambos" per historical month (CPV only applies to the latest month)
  const histBoth=ms.map((m,idx)=>{
   // For historical months we use stats.both (system data as it was at time of import)
   // For the CURRENT (latest) month, we recalc live including CPV overrides
   if(idx===ms.length-1)return ambos;
   return m.both||0;
  });
  const currentBoth=ambos;
  // Smarter projection: use avg of last 3 months growth rate if possible
  let rate;
  if(histBoth.length>=3){
   const recent=histBoth.slice(-3);
   const growths=[];
   for(let i=1;i<recent.length;i++)growths.push(recent[i]-recent[i-1]);
   rate=growths.reduce((a,b)=>a+b,0)/growths.length;
  }else{
   rate=(currentBoth-histBoth[0])/(histBoth.length-1);
  }
  // Build future month labels from last month id (YYYY-MM)
  const lastId=ms[ms.length-1].id||'';
  const parts=lastId.split('-');
  let yr=parseInt(parts[0])||new Date().getFullYear();
  let mo=parseInt(parts[1])||new Date().getMonth()+1;
  const proj=[...histBoth];
  const pL=ms.map(x=>x.name);
  for(let i=1;i<=6;i++){
   mo++;
   if(mo>12){mo=1;yr++}
   proj.push(Math.max(0,Math.round(currentBoth+rate*i)));
   pL.push(MONTH_PT[mo-1].substring(0,3)+'/'+String(yr).slice(-2));
  }
  new Chart(document.getElementById('ch4'),{type:'line',data:{labels:pL,datasets:[
   {label:'Real / Projeção',data:proj,borderColor:'#9d5fe0',backgroundColor:'rgba(157,95,224,.08)',fill:true,tension:.3,pointRadius:4,borderWidth:2.5,pointBackgroundColor:ctx=>ctx.dataIndex>=ms.length-1?'rgba(157,95,224,.6)':'#9d5fe0',segment:{borderDash:ctx=>ctx.p0DataIndex>=ms.length-1?[6,6]:undefined,borderColor:ctx=>ctx.p0DataIndex>=ms.length-1?'rgba(157,95,224,.55)':'#9d5fe0'}},
   {label:'Meta (85 clientes)',data:Array(proj.length).fill(85),borderColor:'#00e5a0',borderWidth:2,borderDash:[8,4],pointRadius:0,fill:false}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,padding:14}},tooltip:{callbacks:{label:function(ctx){const isProj=ctx.dataIndex>=ms.length-1&&ctx.datasetIndex===0;return(isProj?'Projeção: ':ctx.dataset.label+': ')+ctx.parsed.y+(ctx.datasetIndex===0?' clientes':'')}}}},scales:{y:{beginAtZero:true,grid:{color:'rgba(44,37,64,.4)'},ticks:{stepSize:10}},x:{grid:{color:'rgba(44,37,64,.2)'}}}}});
 }else{
  document.getElementById('ch4').parentElement.innerHTML='<h3>Projeção de Atingimento da Meta</h3><div style="display:flex;align-items:center;justify-content:center;height:300px;color:var(--tx3);font-size:.8rem">Importe pelo menos 2 meses para visualizar a projeção</div>'
 }
}

// ============================================================
// IMPORT NEW MONTH
// ============================================================
function showImportModal(){
 if(!isAdmin()){toast('Apenas administradores podem importar',true);return}
 document.getElementById('modal-root').innerHTML=`
<div class="modal-bg" onclick="closeModal()"><div class="modal" onclick="event.stopPropagation()">
 <h2>Importar Planilha do Mês</h2>
 <p>Os dados serão salvos no Google Sheets e sincronizados para todos. Se o mês já existe (mesmo ID), será atualizado — útil para atualizações dentro do mesmo mês.</p>
 <label>Nome do Período</label><input type="text" id="imp-n" placeholder="Ex: Abril 2026">
 <label>ID (YYYY-MM)</label><input type="text" id="imp-id" placeholder="Ex: 2026-04">
 <label>Arquivo .xlsx</label><input type="file" id="imp-f" accept=".xlsx,.xls">
 <div style="background:var(--sf3);border-radius:var(--rx);padding:8px;margin-top:4px">
  <p style="font-size:.68rem;color:var(--tx2);margin:0;line-height:1.4">⚠️ Use a mesma estrutura das planilhas originais (colunas cnpj, NOME TRANSPORTADORA(S), etc).</p></div>
 <div class="modal-btns"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn btn-o" onclick="doImport()">Importar & Enviar</button></div>
</div></div>`}

async function doImport(){
 if(!isAdmin()){toast('Apenas administradores podem importar',true);return}
 const name=document.getElementById('imp-n').value.trim();
 const id=document.getElementById('imp-id').value.trim();
 const file=document.getElementById('imp-f').files[0];
 if(!name||!id||!file){toast('Preencha tudo',true);return}
 if(!/^\d{4}-\d{2}$/.test(id)){toast('ID: YYYY-MM',true);return}
 toast('Processando planilha...');
 try{
  const X=await loadXLSX();
  const d=await file.arrayBuffer();
  const wb=X.read(d);
  const j=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const rows=[];let cpC=0,tlC=0,bC=0,aC=0;
  for(const r of j){
   const cn=String(r.cnpj||''),nm=String(r['NOME TRANSPORTADORA(S)']||'').substring(0,42);
   const cp=r['CONTEÚDO PERSONALIZADO']==='Sim'?1:0,tl=r.TELEMETRIA==='Sim'?1:0;
   // Try to find in lookup, fall back to raw string
   const cavStr=String(r.CAVALEIRO||'').trim();
   const gerStr=String(r['Gerente Sucesso']||'').trim();
   const anaStr=String(r['Analista Sucesso']||'').trim();
   const tpStr=String(r.TIPO||'').trim();
   const esStr=String(r.ESTADO||'').trim();
   const cv=cavStr?(LK.cv.indexOf(cavStr)>=0?LK.cv.indexOf(cavStr):cavStr):-1;
   const gr=gerStr?(LK.gr.indexOf(gerStr)>=0?LK.gr.indexOf(gerStr):gerStr):-1;
   const an=anaStr?(LK.an.indexOf(anaStr)>=0?LK.an.indexOf(anaStr):anaStr):-1;
   const tp=tpStr?(LK.tp.indexOf(tpStr)>=0?LK.tp.indexOf(tpStr):tpStr):-1;
   const es=esStr?(LK.es.indexOf(esStr)>=0?LK.es.indexOf(esStr):esStr):-1;
   let cls=0;const cm=String(r['CLASSIFICAÇÃO CRESCIMENTO']||'').match(/class="(\d+)"/);if(cm)cls=parseInt(cm[1]);
   const dias=Math.round((parseFloat(r['DIAS DE CONTRATO'])||0)*10)/10,ct=parseInt(r['QTD CONTRATOS'])||0;
   rows.push([cn,nm,cp,tl,cv,gr,an,tp,es,cls,dias,ct]);
   if(cp)cpC++;if(tl)tlC++;if(cp&&tl)bC++;
   if(esStr==='Ativo'||esStr==='Recorrente')aC++;
  }
  const newMonth={id,name,stats:{total:rows.length,active:aC,cp:cpC,tel:tlC,both:bC,cpOnly:cpC-bC,telOnly:tlC-bC},rows};
  toast('Enviando para o servidor...');
  const apiRes=await apiCall('save_month',{month:newMonth,user:currentUser.email});
  if(apiRes.ok){
   // Update local
   const existing=DB.months.findIndex(m=>m.id===id);
   if(existing>=0)DB.months[existing]=newMonth;else DB.months.push(newMonth);
   DB.months=sortMonths(normalizeMonths(DB.months));
   viewMi=latI();
   closeModal();render();
   toast(`${name}: ${rows.length} clientes sincronizados!`);
  }else{
   toast('Erro ao salvar: '+apiRes.error,true);
  }
 }catch(e){console.error(e);toast('Erro: '+e.message,true)}
}

let xlsxLib=null;
function loadXLSX(){if(xlsxLib)return Promise.resolve(xlsxLib);return new Promise((r,j)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=()=>{xlsxLib=window.XLSX;r(xlsxLib)};s.onerror=()=>j(new Error('XLSX load fail'));document.head.appendChild(s)})}

// EXPORTS
function expPipeline(){const pipe=computePipeline();const d=lat().rows.map(dec).filter(r=>pipe.cnpjs.has(r.c));expCSV(d.map(r=>({Transportadora:r.n,CNPJ:r.c,'CP Sistema':r.cp?'Sim':'Não','CP Validado':CPV[r.c]?'Sim':'Não',Telemetria:r.tl?'Sim':'Não',Cavaleiro:r.cav,Gerente:r.ger,Analista:r.ana,Tipo:r.tipo,Estado:r.est,Classificação:CLS_L[r.cls],'Dias Contrato':r.dias,Contratos:r.ct})),'pipeline.csv')}
function expBoth(){const d=lat().rows.map(dec).filter(r=>(r.cp||CPV[r.c])&&r.tl);expCSV(d.map(r=>({Transportadora:r.n,CNPJ:r.c,'CP Sistema':r.cp?'Sim':'Não','CP Validado':CPV[r.c]?'Sim':'Não',Cavaleiro:r.cav,Gerente:r.ger,Analista:r.ana,Classificação:CLS_L[r.cls],'Dias Contrato':r.dias,Contratos:r.ct})),'aderidos.csv')}
function expBase(){const mi=viewMi>=0&&viewMi<DB.months.length?viewMi:latI();const mo=DB.months[mi];expCSV(mo.rows.map(dec).map(r=>({Mês:mo.name,Transportadora:r.n,CNPJ:r.c,'CP Sistema':r.cp?'Sim':'Não','CP Validado':CPV[r.c]?'Sim':'Não',Telemetria:r.tl?'Sim':'Não',Cavaleiro:r.cav,Gerente:r.ger,Analista:r.ana,Tipo:r.tipo,Estado:r.est,Classificação:CLS_L[r.cls],'Dias Contrato':r.dias,Contratos:r.ct})),`base_${mo.name.replace(/\s/g,'_').toLowerCase()}.csv`)}

// Full history + quarterly comparison report (multi-section CSV for Excel)
function expHistoryReport(){
 if(!DB.months.length){toast('Sem dados para exportar',true);return}
 const monthMetrics=DB.months.map((m,idx)=>computeMonthMetrics(idx,idx===latI()));
 const quarters=computeQuarterlyMetrics();
 const today=new Date().toLocaleDateString('pt-BR');
 const sep=';';
 const lines=[];
 const push=(arr)=>lines.push(arr.map(v=>{const s=String(v==null?'':v);return s.includes(sep)||s.includes('"')||s.includes('\n')?'"'+s.replace(/"/g,'""')+'"':s}).join(sep));
 const blank=()=>lines.push('');
 push(['RELATÓRIO COMPLETO — OKR ACADEMIA PX']);
 push(['Gerado em:',today]);
 push(['Meta:','Clientes com 2 produtos (CP + Telemetria)']);
 blank();
 push(['=== MÉTRICAS MENSAIS ===']);
 push(['Mês','Trimestre','Meta','Atingido (Ambos)','Gap','% da Meta','Largada do Q','Conquistados no Q (delta)','Esforço Total do Q','% Incremental do Q','CP Sistema','CP Validado','CP Total','Telemetria','Total Base','Ativos/Recorrentes','Churn','Inativos','Cobertura CP %','Cobertura Telemetria %','Cobertura Ambos %']);
 monthMetrics.forEach((m,i)=>{
  if(!m)return;
  const q=getQuarter(DB.months[i].id);
  const bl=getBaselineForQuarter(q.year,q.quarter);
  const qDelta=bl.hasBaseline?(m.current-bl.baseline):'—';
  const qNeeded=bl.hasBaseline?Math.max(0,m.target-bl.baseline):'—';
  const qPct=bl.hasBaseline&&qNeeded>0?(Math.min(100,Math.round(((m.current-bl.baseline)/qNeeded)*1000)/10)+'%'):(bl.hasBaseline?'100%':'—');
  const blDisplay=bl.hasBaseline?(bl.baseline+' ('+bl.startMonth+')'):'Primeiro Q da série';
  push([m.name,q.label,m.target,m.current,m.gap,m.pct+'%',blDisplay,qDelta,qNeeded,qPct,m.cpS,m.cpV,m.cpT,m.tel,m.total,m.active,m.churn,m.inativo,m.cpCoverage+'%',m.telCoverage+'%',m.bothCoverage+'%']);
 });
 blank();blank();
 push(['=== DETALHAMENTO MENSAL POR QUADRANTE ===']);
 monthMetrics.forEach((m,i)=>{
  if(!m)return;
  const q=getQuarter(DB.months[i].id);
  const bl=getBaselineForQuarter(q.year,q.quarter);
  push(['---',m.name+' ('+q.label+')']);
  push(['Atingimento Absoluto']);
  push(['','Atingido',m.current]);
  push(['','Meta',m.target]);
  push(['','% Atingido',m.pct+'%']);
  push(['','Gap',m.gap]);
  push(['Esforço Incremental do Trimestre']);
  if(bl.hasBaseline){
   const qDelta=m.current-bl.baseline;
   const qNeeded=Math.max(0,m.target-bl.baseline);
   const qPct=qNeeded>0?(Math.min(100,Math.round((qDelta/qNeeded)*1000)/10)+'%'):'100%';
   push(['','Largada do Q (ref)',bl.baseline+' clientes em '+bl.startMonth]);
   push(['','Conquistados no Q',(qDelta>=0?'+':'')+qDelta+' clientes']);
   push(['','Esforço total necessário',qNeeded+' clientes']);
   push(['','% do esforço concluído',qPct]);
   push(['','Faltam para meta',Math.max(0,m.target-m.current)+' clientes']);
  }else{
   push(['','Largada do Q (ref)','Primeiro Q da série (sem largada anterior)']);
  }
  push(['Breakdown de Produtos']);
  push(['','CP via Sistema',m.cpS]);
  push(['','CP Validado (manual)',m.cpV]);
  push(['','CP Total',m.cpT]);
  push(['','Telemetria',m.tel]);
  push(['Base de Clientes']);
  push(['','Total no mês',m.total]);
  push(['','Ativos/Recorrentes',m.active]);
  push(['','Em Churn',m.churn]);
  push(['','Inativos',m.inativo]);
  push(['Cobertura']);
  push(['','CP / Total',m.cpCoverage+'%']);
  push(['','Telemetria / Total',m.telCoverage+'%']);
  push(['','Ambos / Total',m.bothCoverage+'%']);
  blank();
 });
 blank();
 push(['=== MÉTRICAS POR TRIMESTRE (snapshot do último mês) ===']);
 push(['Trimestre','Meses incluídos','Meta','Largada','Atingido (Ambos)','Conquistados no Q','% Incremental do Q','Gap','% Absoluto','CP Sistema','CP Validado','Telemetria','Ativos','Churn','Cobertura Ambos %']);
 quarters.forEach(q=>{
  const m=q.metrics;
  const bl=getBaselineForQuarter(q.key.split('-Q')[0]*1,q.key.split('-Q')[1]*1);
  const blDisplay=bl.hasBaseline?(bl.baseline+' ('+bl.startMonth+')'):'—';
  const qDelta=bl.hasBaseline?(m.current-bl.baseline):'—';
  const qNeeded=bl.hasBaseline?Math.max(0,m.target-bl.baseline):0;
  const qPct=bl.hasBaseline&&qNeeded>0?(Math.min(100,Math.round(((m.current-bl.baseline)/qNeeded)*1000)/10)+'%'):(bl.hasBaseline?'100%':'—');
  push([q.label,q.months.join(' + '),m.target,blDisplay,m.current,qDelta,qPct,m.gap,m.pct+'%',m.cpS,m.cpV,m.tel,m.active,m.churn,m.bothCoverage+'%']);
 });
 blank();blank();
 if(quarters.length>=2){
  push(['=== COMPARATIVO TRIMESTRAL (evolução entre trimestres) ===']);
  push(['Transição','Métrica','De','Para','Delta (abs)','Delta (%)','Interpretação']);
  for(let i=1;i<quarters.length;i++){
   const cur=quarters[i],prev=quarters[i-1];
   const cm=cur.metrics,pm=prev.metrics;
   const label=prev.label+' → '+cur.label;
   const mkRow=(metric,from,to,goodUp)=>{
    const delta=to-from;
    const deltaPct=from!==0?Math.round((delta/from)*1000)/10+'%':'—';
    const positive=delta>0;
    const isGood=goodUp?positive:!positive;
    const interp=delta===0?'Estável':(isGood?'↑ Evolução positiva':'↓ Precisa atenção');
    push([label,metric,from,to,(positive?'+':'')+delta,deltaPct,interp]);
   };
   mkRow('Atingido (Ambos)',pm.current,cm.current,true);
   mkRow('% da Meta',pm.pct,cm.pct,true);
   mkRow('CP Sistema',pm.cpS,cm.cpS,true);
   mkRow('CP Validado',pm.cpV,cm.cpV,true);
   mkRow('Telemetria',pm.tel,cm.tel,true);
   mkRow('Ativos/Recorrentes',pm.active,cm.active,true);
   mkRow('Churn',pm.churn,cm.churn,false);
   mkRow('Cobertura Ambos %',pm.bothCoverage,cm.bothCoverage,true);
   blank();
  }
 }
 blank();
 push(['--- Fim do relatório ---']);
 push(['Fonte:','Dashboard OKR Academia PX']);
 push(['Metodologia — % Absoluto vs % Incremental:']);
 push(['','% Absoluto: atingido / meta total. Diz quão perto estamos da linha de chegada. Bom para reporting externo.']);
 push(['','% Incremental: conquistados no trimestre / esforço total necessário no trimestre. Diz o quanto do trabalho do trimestre já foi feito. Essencial para gestão operacional do time.']);
 push(['','Largada: estado inicial do trimestre (snapshot herdado do fechamento do trimestre anterior). No Q2 2026 a largada é 41 clientes em Abril 2026.']);
 push(['Observação técnica:','Dados de meses históricos refletem o snapshot no momento da importação. O mês atual considera atualizações de CP Validado em tempo real.']);
 const csv=lines.join('\n');
 const b=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'});
 const a=document.createElement('a');
 const fn=`relatorio_okr_academia_px_${new Date().toISOString().slice(0,10)}.csv`;
 a.href=URL.createObjectURL(b);a.download=fn;a.click();
 toast('Relatório exportado: '+fn);
}

// ============================================================
// BOOT
// ============================================================
(async()=>{
 // Update sync badge every second
 setInterval(updateSyncBadge,1000);
 
 // Check if already logged in
 const storedUser=localStorage.getItem('okr-apx-user');
 const storedToken=localStorage.getItem('okr-apx-token');
 if(storedUser&&storedToken&&apiURL){
  currentUser=JSON.parse(storedUser);
  authToken=storedToken;
  await enterApp();
 }
 // Focus email on login
 const e=document.getElementById('login-email');
 if(e)e.focus();
 // Enter key submits
 document.getElementById('login-pass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
 document.getElementById('login-email').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('login-pass').focus()});
})();


// ============================================================
// MOTOR PX EXPERIENCE LAYER
// Camada exclusivamente visual e de navegação. As regras de negócio
// e o formato dos dados permanecem sob responsabilidade do app original.
// ============================================================
function setWorkspaceTheme(theme){
 const next=theme==='dark'?'dark':'light';
 document.documentElement.dataset.workspaceTheme=next;
 try{localStorage.setItem('okr-apx-workspace-theme',next)}catch(e){}
 const button=document.getElementById('workspace-theme');
 if(button)button.textContent=next==='light'?'◐ Tema escuro':'☀ Tema claro';
}

function toggleWorkspaceTheme(){
 setWorkspaceTheme(document.documentElement.dataset.workspaceTheme==='light'?'dark':'light');
}

function toggleWorkspaceNav(){
 const workspace=document.querySelector('.motor-workspace');
 if(!workspace)return;
 if(window.matchMedia('(max-width:1180px)').matches){
  const open=workspace.classList.toggle('nav-open');
  const button=document.getElementById('workspace-nav-toggle');
  if(button){button.setAttribute('aria-label',open?'Fechar menu':'Abrir menu');button.title=open?'Fechar menu':'Abrir menu'}
  return;
 }
 const collapsed=workspace.classList.toggle('nav-collapsed');
 try{localStorage.setItem('okr-apx-nav-collapsed',collapsed?'1':'0')}catch(e){}
 const button=document.getElementById('workspace-nav-toggle');
 if(button){button.setAttribute('aria-label',collapsed?'Expandir menu':'Recolher menu');button.title=collapsed?'Expandir menu':'Recolher menu'}
}

function goWorkspaceTab(next){
 drilldown=null;tab=next;pg=0;searchVal='';
 document.querySelector('.motor-workspace')?.classList.remove('nav-open');
 const navButton=document.getElementById('workspace-nav-toggle');
 if(navButton&&window.matchMedia('(max-width:1180px)').matches){navButton.setAttribute('aria-label','Abrir menu');navButton.title='Abrir menu'}
 updateTabs();renderContent();
}

function workspaceRecommendation(okr,pipe){
 if(okr.gap<=0)return 'Meta atingida. Priorize retenção, qualidade da implantação e consolidação dos clientes aderidos.';
 if(pipe.seg.tel>0)return `Ative Conteúdo Personalizado em ${pipe.seg.tel} clientes que já possuem Telemetria.`;
 if(pipe.seg.cp>0)return `Converta Telemetria em ${pipe.seg.cp} clientes que já possuem Conteúdo Personalizado.`;
 if(pipe.seg.none>0)return `Inicie abordagem combinada nos ${pipe.seg.none} clientes elegíveis ainda sem produtos.`;
 return 'Revise a base elegível e acompanhe novos clientes com potencial para o próximo fechamento.';
}

function workspaceDecision(okr,pipe){
 const available=pipe.cnpjs.size;
 if(okr.gap<=0)return{tone:'success',label:'Meta atingida',text:'A meta absoluta foi alcançada. Direcione a operação para adoção, retenção e qualidade das ativações.',rate:0,balance:available};
 if(!available)return{tone:'risk',label:'Pipeline insuficiente',text:`Faltam ${okr.gap} clientes para a meta e não há contas elegíveis no pipeline atual. Revise a base e os critérios de entrada.`,rate:null,balance:-okr.gap};
 const rate=Math.round(okr.gap/available*1000)/10;
 const balance=available-okr.gap;
 if(balance>=0)return{tone:rate<=35?'success':'attention',label:'Pipeline suficiente',text:`Converter ${okr.gap} de ${available} oportunidades (${rate}%) é suficiente para atingir a meta.`,rate,balance};
 return{tone:'risk',label:'Cobertura insuficiente',text:`Mesmo convertendo todo o pipeline, ainda faltarão ${Math.abs(balance)} clientes. Amplie a geração de oportunidades elegíveis.`,rate,balance};
}

function workspacePercent(value,total){return total?Math.round(value/total*1000)/10:0}

function buildWorkspacePulse(){
 const okr=computeOKR();
 const qp=computeQuarterProgress();
 const pipe=computePipeline();
 const total=lat()?.rows?.length||0;
 const coverage=total?Math.round(okr.current/total*1000)/10:0;
 const decision=workspaceDecision(okr,pipe);
 const el=document.createElement('section');
 el.className='motor-pulse';
 el.setAttribute('aria-label','Placar executivo');
 el.innerHTML=`
  <div class="motor-pulse-heading"><div><span>PLACAR EXECUTIVO</span><strong>${qp?.quarterLabel||getCurrentQuarterKey()}</strong></div><small>${lat()?.name||'Sem fechamento'}</small></div>
  <button class="motor-pulse-card primary" onclick="goWorkspaceTab('overview')"><span>Posição absoluta</span><strong>${okr.current}<em> / ${okr.target}</em></strong><small>${okr.pct}% da meta total</small><i style="--value:${okr.pct}%"><b></b></i></button>
  <button class="motor-pulse-card quarter" onclick="goWorkspaceTab('overview')"><span>Avanço no trimestre</span><strong>${Math.max(0,qp?.delta||0)}<em> / ${qp?.deltaNeeded||okr.target}</em></strong><small>${qp?.pctIncremental??okr.pct}% do esforço trimestral</small><i style="--value:${qp?.pctIncremental??okr.pct}%"><b></b></i></button>
  <button class="motor-pulse-card alert" onclick="openDrill('both')"><span>Distância da meta</span><strong>${okr.gap}</strong><small>${okr.gap===1?'cliente restante':'clientes restantes'}</small><i style="--value:${Math.min(100,okr.pct)}%"><b></b></i></button>
  <button class="motor-pulse-card pipeline" onclick="goWorkspaceTab('pipeline')"><span>Pipeline acionável</span><strong>${pipe.cnpjs.size}</strong><small>${decision.rate===null?'sem cobertura':decision.rate+'% de conversão necessária'}</small><i style="--value:${Math.min(100,workspacePercent(Math.min(pipe.cnpjs.size,okr.gap),Math.max(1,okr.gap)))}%"><b></b></i></button>
  <div class="motor-next-action ${decision.tone}"><span>${decision.label}</span><strong>${decision.text} ${workspaceRecommendation(okr,pipe)}</strong><button onclick="goWorkspaceTab('pipeline')">Ver oportunidades →</button></div>`;
 return el;
}

function enhanceWorkspace(){
 const app=document.getElementById('app');
 if(!app||app.querySelector('.motor-workspace'))return;
 const hdr=app.querySelector('.hdr');
 const hero=app.querySelector('.hero');
 const legend=app.querySelector('.legend');
 const tabs=app.querySelector('.tabs');
 const content=app.querySelector('#ct');
 if(!hdr||!hero||!tabs||!content)return;

 if(!tabs.querySelector('[data-tab="methodology"]')){
  const method=document.createElement('button');
  method.className='tab';method.dataset.tab='methodology';
  method.textContent='Metodologia';
  method.onclick=()=>goWorkspaceTab('methodology');
  tabs.appendChild(method);
 }

 const labels={overview:'Visão executiva',pipeline:'Oportunidades',clients:'Aderidos',base:'Carteira completa',new:'Novos clientes',history:'Histórico',methodology:'Metodologia'};
 const icons={overview:'⌂',pipeline:'◎',clients:'✓',base:'▤',new:'＋',history:'◫',methodology:'i'};
 tabs.querySelectorAll('[data-tab]').forEach(button=>{
  const key=button.dataset.tab;
  const badge=button.querySelector('.bd')?.outerHTML||'';
  button.innerHTML=`<i>${icons[key]||'•'}</i><span>${labels[key]||key}</span>${badge}`;
 });
 tabs.classList.add('motor-nav');

 const workspace=document.createElement('div');workspace.className='motor-workspace';
 const sidebar=document.createElement('aside');sidebar.className='motor-sidebar';
 const main=document.createElement('main');main.className='motor-main';
 const month=lat()?.name||'Sem período';
 const role=currentUser?.role==='admin'?'Administrador':'Membro';
 sidebar.innerHTML=`
  <div class="motor-brand"><button id="workspace-nav-toggle" onclick="toggleWorkspaceNav()" aria-label="Recolher menu" title="Recolher menu"><i></i></button></div>
  <div class="motor-nav-label">NAVEGAÇÃO OPERACIONAL</div>`;
 sidebar.appendChild(tabs);
 sidebar.insertAdjacentHTML('beforeend',`
  <div class="motor-sidebar-context"><span>Período de referência</span><strong>${month}</strong><small>${DB.months.length} ${DB.months.length===1?'fechamento':'fechamentos'} preservados</small></div>
  <div class="motor-sidebar-user"><div>${(currentUser?.name||currentUser?.email||'U').slice(0,1).toUpperCase()}</div><span><strong>${currentUser?.name||currentUser?.email||'Usuário'}</strong><small>${role}</small></span></div>`);

 hdr.classList.add('motor-topbar');
 const actions=hdr.querySelector('.hdr-r');
 if(actions&&!document.getElementById('workspace-theme')){
  actions.insertAdjacentHTML('afterbegin','<button class="btn workspace-menu" onclick="toggleWorkspaceNav()" aria-label="Abrir navegação">☰</button><button class="btn" id="workspace-theme" onclick="toggleWorkspaceTheme()"></button>');
 }
 const title=hdr.querySelector('.hdr-title p');
 if(title)title.innerHTML=`<strong>Central de performance</strong><span>Conteúdo Personalizado &amp; Telemetria · ${month}</span>`;

 app.textContent='';
 app.appendChild(workspace);workspace.append(sidebar,main);
 main.append(hdr,buildWorkspacePulse(),hero);
 if(legend)main.appendChild(legend);
 main.appendChild(content);
 try{
  if(localStorage.getItem('okr-apx-nav-collapsed')==='1'){
   workspace.classList.add('nav-collapsed');
   const navButton=document.getElementById('workspace-nav-toggle');
   if(navButton){navButton.setAttribute('aria-label','Expandir menu');navButton.title='Expandir menu'}
  }
 }catch(e){}
 setWorkspaceTheme((()=>{try{return localStorage.getItem('okr-apx-workspace-theme')||'light'}catch(e){return'light'}})());
 updateTabs();makeClientRowsInteractive();
}

function renderStrategicOverview(ct){
 renderOverview(ct);
 const okr=computeOKR();
 const qp=computeQuarterProgress();
 const pipe=computePipeline();
 const total=lat()?.rows?.length||0;
 const cpEffective=okr.cpS+okr.cpV;
 const missingCP=pipe.seg.none+pipe.seg.tel;
 const missingTEL=pipe.seg.none+pipe.seg.cp;
 const decision=workspaceDecision(okr,pipe);
 const runway=pipe.cnpjs.size-okr.gap;
 const section=document.createElement('section');
 section.className='motor-strategy';
 section.innerHTML=`
  <div class="motor-strategy-head"><div><span>LEITURA ESTRATÉGICA</span><h2>Rota de atingimento da meta</h2><p>Visão consolidada do fechamento, do esforço trimestral e do potencial de conversão.</p></div><div class="motor-confidence ${decision.tone}"><small>${decision.label}</small><strong>${runway>=0?'+'+runway:runway}</strong><span>saldo entre pipeline e gap</span></div></div>
  <div class="motor-strategy-grid">
   <article class="motor-route-card">
    <div class="motor-card-title"><div><span>01 · META</span><h3>Da largada ao objetivo</h3></div><strong>${qp?.pctIncremental??okr.pct}%</strong></div>
    <div class="motor-route-track"><i class="start" style="left:${workspacePercent(qp?.baseline||0,okr.target)}%"></i><b style="width:${okr.pct}%"></b></div>
    <div class="motor-route-labels"><span><small>Largada</small><strong>${qp?.baseline||0}</strong></span><span><small>Atual</small><strong>${okr.current}</strong></span><span><small>Meta</small><strong>${okr.target}</strong></span></div>
    <p>${decision.text}</p>
   </article>
   <article class="motor-funnel-card">
    <div class="motor-card-title"><div><span>02 · ADOÇÃO</span><h3>Funil dos produtos</h3></div><small>${fmt(total)} clientes na base</small></div>
    <button onclick="openDrill('cpSys')"><span>CP efetivo</span><i><b style="width:${workspacePercent(cpEffective,total)}%"></b></i><strong>${cpEffective}<small>${workspacePercent(cpEffective,total)}%</small></strong></button>
    <button onclick="openDrill('tel')"><span>Telemetria</span><i><b style="width:${workspacePercent(okr.tel,total)}%"></b></i><strong>${okr.tel}<small>${workspacePercent(okr.tel,total)}%</small></strong></button>
    <button onclick="openDrill('both')"><span>Ambos</span><i><b style="width:${workspacePercent(okr.current,total)}%"></b></i><strong>${okr.current}<small>${workspacePercent(okr.current,total)}%</small></strong></button>
   </article>
   <article class="motor-priority-card">
    <div class="motor-card-title"><div><span>03 · PRIORIZAÇÃO</span><h3>Lacunas no pipeline</h3></div><button onclick="goWorkspaceTab('pipeline')">Abrir pipeline</button></div>
    <div><button onclick="pipeF='telonly';goWorkspaceTab('pipeline')"><small>Falta Conteúdo Personalizado</small><strong>${missingCP}</strong><span>${pipe.seg.tel} já possuem Telemetria</span></button><button onclick="pipeF='cponly';goWorkspaceTab('pipeline')"><small>Falta Telemetria</small><strong>${missingTEL}</strong><span>${pipe.seg.cp} já possuem CP</span></button><button onclick="pipeF='none';goWorkspaceTab('pipeline')"><small>Sem os dois produtos</small><strong>${pipe.seg.none}</strong><span>abordagem combinada</span></button></div>
   </article>
  </div>`;
 ct.prepend(section);
}

function escapeWorkspaceHTML(value){
 return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function makeClientRowsInteractive(){
 document.querySelectorAll('#ct table tbody tr').forEach(row=>{
  const cell=row.querySelector('td:first-child');
  const strong=cell?.querySelector('strong');
  const meta=cell?.querySelector('span');
  if(!strong||!meta||strong.dataset.profileReady)return;
  const cnpj=meta.textContent.trim();
  if(!cnpj||!DB.months.some(month=>month.rows.some(raw=>String(raw[0])===cnpj)))return;
  const button=document.createElement('button');button.className='motor-client-link';
  button.textContent=strong.textContent;button.type='button';button.onclick=()=>openClientProfile(cnpj);
  strong.dataset.profileReady='1';strong.replaceWith(button);
 });
}

function closeClientProfile(){
 const root=document.getElementById('client-profile-root');
 if(root)root.remove();
}

function openClientProfile(cnpj){
 const snapshots=DB.months.map((month,index)=>{
  const raw=month.rows.find(item=>String(item[0])===String(cnpj));
  if(!raw)return null;
  const row=dec(raw);
  return{month,index,row,cp:row.cp||(index===latI()&&CPV[row.c]===true)};
 }).filter(Boolean);
 if(!snapshots.length)return;
 const latest=snapshots[snapshots.length-1];
 const first=snapshots[0];
 const r=latest.row;
 const both=latest.cp&&r.tl;
 const action=both?'Consolidar valor percebido, acompanhar adoção e proteger a permanência dos dois produtos.':latest.cp?'Priorizar ativação de Telemetria para completar a aderência.':r.tl?'Priorizar proposta de Conteúdo Personalizado para completar a aderência.':computePipeline().cnpjs.has(r.c)?'Cliente elegível: estruturar abordagem dos dois produtos e acompanhar conversão.':'Manter em observação e revisar o potencial no próximo fechamento.';
 const maxDays=Math.max(1,...snapshots.map(item=>Number(item.row.dias)||0));
 closeClientProfile();
 const root=document.createElement('div');root.id='client-profile-root';root.className='motor-drawer-backdrop';
 root.onclick=event=>{if(event.target===root)closeClientProfile()};
 root.innerHTML=`<aside class="motor-drawer" role="dialog" aria-modal="true" aria-labelledby="client-profile-title">
  <button class="motor-drawer-close" onclick="closeClientProfile()" aria-label="Fechar">×</button>
  <div class="motor-eyebrow">VISÃO 360° DA CONTA</div>
  <h2 id="client-profile-title">${escapeWorkspaceHTML(r.n)}</h2>
  <p class="motor-drawer-sub">${escapeWorkspaceHTML(r.c)} · ${escapeWorkspaceHTML(r.tipo)} · ${escapeWorkspaceHTML(r.est)}</p>
  <section class="motor-client-action"><span>Próxima ação recomendada</span><strong>${escapeWorkspaceHTML(action)}</strong></section>
  <section class="motor-client-kpis">
   <article><span>Dias atuais</span><strong>${fmtD(r.dias)}</strong><small>${snapshots.length>1?`${r.dias-first.row.dias>=0?'+':''}${fmtD(r.dias-first.row.dias)} desde ${first.month.name}`:'primeiro fechamento'}</small></article>
   <article><span>Contratos</span><strong>${fmt(r.ct)}</strong><small>no fechamento atual</small></article>
   <article><span>Conteúdo Personalizado</span><strong>${latest.cp?'Sim':'Não'}</strong><small>${r.cp?'via sistema':CPV[r.c]?'validado pelo time':'sem ativação'}</small></article>
   <article><span>Telemetria</span><strong>${r.tl?'Sim':'Não'}</strong><small>${both?'aderência completa':'oportunidade aberta'}</small></article>
  </section>
  <section class="motor-profile-section"><div class="motor-section-head"><div><h3>Evolução da conta</h3><p>Todos os fechamentos preservados para este cliente</p></div><span>${snapshots.length} períodos</span></div>
   <div class="motor-history-bars">${snapshots.map(item=>`<div><b>${fmtD(item.row.dias)}</b><i style="height:${Math.max(5,Math.round(item.row.dias/maxDays*100))}%"></i><small>${escapeWorkspaceHTML(item.month.name.split(' ')[0])}</small></div>`).join('')}</div>
  </section>
  <section class="motor-profile-grid"><article><span>Cavaleiro</span><strong>${escapeWorkspaceHTML(r.cav)}</strong></article><article><span>Gerente</span><strong>${escapeWorkspaceHTML(r.ger)}</strong></article><article><span>Analista</span><strong>${escapeWorkspaceHTML(r.ana)}</strong></article><article><span>Classificação</span><strong>${escapeWorkspaceHTML(r.cls)}</strong></article></section>
 </aside>`;
 document.body.appendChild(root);
}

function renderMethodology(ct){
 const keys=Object.entries(TARGETS).sort(([a],[b])=>a.localeCompare(b));
 ct.innerHTML=`
  <div class="motor-page-heading"><div><span>GOVERNANÇA DA MÉTRICA</span><h2>Metodologia e regras preservadas</h2><p>Memória operacional das regras que sustentam o painel e permanecem inalteradas nesta evolução.</p></div><button class="btn btn-g" onclick="showTargetModal()" ${isAdmin()?'':'disabled'}>Ajustar meta trimestral</button></div>
  <section class="motor-method-grid">
   <article><b>01</b><h3>Meta trimestral</h3><p>Cada trimestre possui uma meta independente. Alterar um trimestre não reescreve metas nem snapshots anteriores.</p></article>
   <article><b>02</b><h3>Largada do trimestre</h3><p>A largada usa o último fechamento anterior ao trimestre. O avanço incremental mede apenas o esforço realizado dentro do período.</p></article>
   <article><b>03</b><h3>Ambos — efetivo</h3><p>Conta com Conteúdo Personalizado via sistema ou validação manual e Telemetria ativa no mesmo fechamento.</p></article>
   <article><b>04</b><h3>Pipeline elegível</h3><p>Clientes cuja média de dias dos três fechamentos mais recentes é igual ou superior a 150.</p></article>
   <article><b>05</b><h3>CP Validado</h3><p>Override administrativo para proposta aceita. O histórico mantém o snapshot de cada mês; o override ao vivo vale no fechamento atual.</p></article>
   <article><b>06</b><h3>Perfis de acesso</h3><p>Administradores podem importar, validar, excluir e ajustar metas. Membros permanecem em modo de consulta e exportação.</p></article>
  </section>
  <section class="motor-targets-panel"><div class="motor-section-head"><div><h3>Metas configuradas</h3><p>Referência persistida por trimestre</p></div><span>${keys.length} configurações</span></div><div>${keys.map(([key,value])=>`<button onclick="showTargetModal('${key}')"><span>${key}</span><strong>${value} clientes</strong></button>`).join('')}</div></section>
  <section class="motor-preservation"><strong>Garantia de preservação</strong><p>A nova navegação não altera o formato dos meses, linhas, índices, CPV, metas, cache ou payloads do backend. Importação e exportação continuam usando as mesmas funções existentes.</p></section>`;
}

document.addEventListener('keydown',event=>{if(event.key==='Escape')closeClientProfile()});
