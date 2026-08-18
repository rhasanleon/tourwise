const firebaseConfig = window.TOURWISE_FIREBASE_CONFIG || null;
const FUNCTIONS_BASE_URL = window.TOURWISE_FUNCTIONS_URL || "";
let db = null;
let firebase = null;
let unsubscribe = null;
let state = { trip: null, members: [], expenses: [], mode: "local" };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const shareKeyFromUrl = params.get("trip");

async function initFirebase() {
  if (!firebaseConfig?.apiKey) return false;
  try {
    const appMod = await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js");
    const fs = await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js");
    const app = appMod.initializeApp(firebaseConfig);
    db = fs.getFirestore(app);
    firebase = fs;
    state.mode = "firebase";
    return true;
  } catch (e) { console.error("Firebase init failed", e); return false; }
}

function uid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now().toString(36); }
function shareKey() { const a=new Uint8Array(16); crypto.getRandomValues(a); return [...a].map(x=>x.toString(16).padStart(2,"0")).join(""); }
function money(n=0) { return new Intl.NumberFormat(undefined,{style:"currency",currency:state.trip?.currency||"USD"}).format(Number(n)||0); }
function fmtDate(ts){const d=ts?.toDate?ts.toDate():new Date(ts);return d.toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}

function storageKey(key){ return `tourwise:${key}`; }
function loadLocal(key){ const x=localStorage.getItem(storageKey(key)); return x?JSON.parse(x):null; }
function saveLocal(){ if(state.trip) localStorage.setItem(storageKey(state.trip.shareKey),JSON.stringify({trip:state.trip,members:state.members,expenses:state.expenses})); }

async function createTrip(data){
  const key=shareKey();
  const trip={id:key,shareKey:key,name:data.name,currency:data.currency,createdAt:new Date().toISOString()};
  const creator={id:uid(),name:data.creatorName,phone:data.creatorPhone,budget:Number(data.creatorBudget),createdAt:new Date().toISOString()};
  if(state.mode==="firebase"){
    await firebase.setDoc(firebase.doc(db,"trips",key),trip);
    await firebase.setDoc(firebase.doc(db,"trips",key,"members",creator.id),creator);
  }else{ state={...state,trip,members:[creator],expenses:[]}; saveLocal(); }
  location.href=`?trip=${encodeURIComponent(key)}`;
}

async function subscribeTrip(key){
  if(state.mode==="firebase"){
    const tripRef=firebase.doc(db,"trips",key);
    const snap=await firebase.getDoc(tripRef);
    if(!snap.exists()){ alert("Trip not found."); return; }
    state.trip=snap.data();
    const membersQ=firebase.query(firebase.collection(db,"trips",key,"members"));
    const expensesQ=firebase.query(firebase.collection(db,"trips",key,"expenses"),firebase.orderBy("createdAt","desc"));
    const u1=firebase.onSnapshot(membersQ,s=>{state.members=s.docs.map(d=>d.data());render();});
    const u2=firebase.onSnapshot(expensesQ,s=>{state.expenses=s.docs.map(d=>d.data());render();});
    unsubscribe=()=>{u1();u2();};
  }else{
    const saved=loadLocal(key);
    if(!saved){ alert("This trip is not in this browser. Configure Firebase for shareable trips."); return; }
    state={...state,...saved}; render();
  }
}

async function addMember(m){
  const member={id:uid(),name:m.name,phone:m.phone,budget:Number(m.budget),createdAt:new Date().toISOString()};
  if(state.mode==="firebase") await firebase.setDoc(firebase.doc(db,"trips",state.trip.shareKey,"members",member.id),member);
  else {state.members.push(member);saveLocal();render();}
}

async function updateBudget(memberId,budget){
  if(state.mode==="firebase") await firebase.updateDoc(firebase.doc(db,"trips",state.trip.shareKey,"members",memberId),{budget:Number(budget)});
  else {const m=state.members.find(x=>x.id===memberId); if(m)m.budget=Number(budget);saveLocal();render();}
}

async function addExpense(e){
  const expense={id:uid(),description:e.description,amount:Number(e.amount),payerId:e.payerId,participantIds:e.participantIds,createdAt:new Date().toISOString()};
  if(state.mode==="firebase") await firebase.setDoc(firebase.doc(db,"trips",state.trip.shareKey,"expenses",expense.id),expense);
  else {state.expenses.unshift(expense);saveLocal();render();}
  await notifyMembers(expense);
}

function accounting(){
  const net=Object.fromEntries(state.members.map(m=>[m.id,0]));
  const spentBy=Object.fromEntries(state.members.map(m=>[m.id,0]));
  for(const e of state.expenses){
    if(!(e.payerId in net)) continue;
    net[e.payerId]+=e.amount; spentBy[e.payerId]+=e.amount;
    const included=(e.participantIds||[]).filter(id=>id in net);
    if(!included.length) continue;
    const share=e.amount/included.length;
    included.forEach(id=>net[id]-=share);
  }
  const creditors=Object.entries(net).filter(([,v])=>v>.005).map(([id,v])=>({id,v})).sort((a,b)=>b.v-a.v);
  const debtors=Object.entries(net).filter(([,v])=>v<-.005).map(([id,v])=>({id,v:-v})).sort((a,b)=>b.v-a.v);
  const transfers=[]; let i=0,j=0;
  while(i<debtors.length&&j<creditors.length){const amt=Math.min(debtors[i].v,creditors[j].v);transfers.push({from:debtors[i].id,to:creditors[j].id,amount:amt});debtors[i].v-=amt;creditors[j].v-=amt;if(debtors[i].v<.005)i++;if(creditors[j].v<.005)j++;}
  return {net,spentBy,transfers};
}

async function notifyMembers(expense){
  const box=$("smsStatus"); box.hidden=false;
  if(!FUNCTIONS_BASE_URL){box.textContent="Expense saved. SMS is not enabled yet — add your Firebase Function URL in config.js.";return;}
  try{
    box.textContent="Sending SMS updates…";
    const res=await fetch(`${FUNCTIONS_BASE_URL.replace(/\/$/,"")}/notifyExpense`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tripKey:state.trip.shareKey,expenseId:expense.id})});
    if(!res.ok)throw new Error(await res.text());
    const out=await res.json(); box.textContent=`Expense saved. SMS sent to ${out.sent||0} tour mate(s).`;
  }catch(err){console.error(err);box.textContent="Expense saved, but SMS failed. Check the function deployment and Twilio setup.";}
}

function render(){
  if(!state.trip)return;
  $("landingView").hidden=true; $("tripView").hidden=false; $("shareBtn").hidden=false;
  $("tripTitle").textContent=state.trip.name; $("tripMeta").textContent=`${state.trip.currency} • ${state.mode==="firebase"?"Live shared trip":"Local demo mode"}`;
  const total=state.expenses.reduce((s,e)=>s+Number(e.amount||0),0); const a=accounting();
  $("totalSpent").textContent=money(total);$("memberCount").textContent=state.members.length;$("expenseCount").textContent=state.expenses.length;$("unsettledTotal").textContent=money(a.transfers.reduce((s,t)=>s+t.amount,0));
  $("expensePayer").innerHTML=state.members.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  $("splitMembers").innerHTML=state.members.map(m=>`<label class="check-pill"><input type="checkbox" value="${m.id}" checked> ${escapeHtml(m.name)}</label>`).join("");
  $("memberList").innerHTML=state.members.map(m=>{const spent=a.spentBy[m.id]||0,b=Number(m.budget||0),pct=b?Math.min(100,(spent/b)*100):0,remaining=b-spent;return `<div class="member"><div class="member-head"><div><div class="member-name">${escapeHtml(m.name)}</div><div class="member-phone">${escapeHtml(m.phone)}</div></div><button class="link-btn" data-budget="${m.id}">Edit budget</button></div><div class="budget-bar"><div class="budget-fill ${remaining<0?'over':''}" style="width:${b?pct:0}%"></div></div><div class="budget-meta"><span>Spent ${money(spent)} / ${money(b)}</span><span>${remaining>=0?money(remaining)+' left':money(Math.abs(remaining))+' over'}</span></div></div>`}).join("")||"<div class='empty'>No members.</div>";
  $("expenseList").classList.toggle("empty",!state.expenses.length);$("expenseList").innerHTML=state.expenses.length?state.expenses.map(e=>{const p=state.members.find(m=>m.id===e.payerId);return `<div class="row"><div><div class="row-title">${escapeHtml(e.description)}</div><div class="row-sub">Paid by ${escapeHtml(p?.name||'Unknown')} • ${e.participantIds?.length||0} people • ${fmtDate(e.createdAt)}</div></div><div class="money">${money(e.amount)}</div></div>`}).join(""):"No expenses yet.";
  $("settlementList").classList.toggle("empty",!a.transfers.length);$("settlementList").innerHTML=a.transfers.length?a.transfers.map(t=>{const f=state.members.find(m=>m.id===t.from),to=state.members.find(m=>m.id===t.to);return `<div class="settle"><span><b>${escapeHtml(f?.name||'Unknown')}</b> pays <b>${escapeHtml(to?.name||'Unknown')}</b></span><strong>${money(t.amount)}</strong></div>`}).join(""):"Nothing to settle yet.";
  document.querySelectorAll("[data-budget]").forEach(b=>b.onclick=()=>openBudget(b.dataset.budget));
}
function escapeHtml(s=""){return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));}
function openBudget(id){const m=state.members.find(x=>x.id===id);if(!m)return;$("budgetMemberId").value=id;$("budgetMemberName").textContent=m.name;$("budgetAmount").value=m.budget||0;$("budgetDialog").showModal();}
function copyLink(){navigator.clipboard.writeText(location.href);const b=$("copyLinkBtn");const old=b.textContent;b.textContent="Copied";setTimeout(()=>b.textContent=old,1200);}

$("createTripForm").addEventListener("submit",async e=>{e.preventDefault();await createTrip({name:$("tripName").value.trim(),currency:$("currency").value,creatorName:$("creatorName").value.trim(),creatorPhone:$("creatorPhone").value.trim(),creatorBudget:$("creatorBudget").value});});
$("expenseForm").addEventListener("submit",async e=>{e.preventDefault();const participantIds=[...$("splitMembers").querySelectorAll("input:checked")].map(x=>x.value);if(!participantIds.length){alert("Select at least one participant.");return;}await addExpense({description:$("expenseDescription").value.trim(),amount:$("expenseAmount").value,payerId:$("expensePayer").value,participantIds});e.target.reset();render();});
$("openMemberBtn").onclick=()=>$("memberDialog").showModal();$("closeMemberBtn").onclick=()=>$("memberDialog").close();
$("memberForm").addEventListener("submit",async e=>{e.preventDefault();await addMember({name:$("memberName").value.trim(),phone:$("memberPhone").value.trim(),budget:$("memberBudget").value});$("memberDialog").close();e.target.reset();});
$("closeBudgetBtn").onclick=()=>$("budgetDialog").close();$("budgetForm").addEventListener("submit",async e=>{e.preventDefault();await updateBudget($("budgetMemberId").value,$("budgetAmount").value);$("budgetDialog").close();});
$("copyLinkBtn").onclick=copyLink;$("shareBtn").onclick=copyLink;

await initFirebase();
if(shareKeyFromUrl) await subscribeTrip(shareKeyFromUrl);
