import { ACTIONS } from "./action-registry.js";

const $ = (id) => document.getElementById(id);
const els = {
  sidebar:$("sidebar"), backdrop:$("backdrop"), menu:$("menuButton"),
  statusButton:$("statusButton"), statusDot:$("statusDot"), statusText:$("statusText"),
  sideDot:$("sideDot"), sideStatus:$("sideStatus"), sideModel:$("sideModel"),
  viewLabel:$("viewLabel"), systemTime:$("systemTime"), coreState:$("coreState"),
  modelText:$("dashModel"), dashCore:$("dashCore"), dashModel:$("dashModel"), dashTools:$("dashTools"),
  dashSession:$("dashSession"), dashBackend:$("dashBackend"), dashKey:$("dashKey"), dashChecked:$("dashChecked"),
  messages:$("messages"), form:$("chatForm"), input:$("messageInput"), send:$("sendButton"),
  attach:$("attachButton"), fileInput:$("fileInput"), attachmentBar:$("attachmentBar"),
  newChat:$("newChatButton"), memoryForm:$("memoryForm"), memoryInput:$("memoryInput"), memoryList:$("memoryList"),
  taskForm:$("taskForm"), taskTitle:$("taskTitle"), taskDue:$("taskDue"), taskList:$("taskList"),
  pageFileInput:$("pageFileInput"), analyzePageFile:$("analyzePageFile"), fileList:$("fileList"),
  backendUrlInput:$("backendUrlInput"), saveBackend:$("saveBackend"), testConnection:$("testConnection"),
  compactToggle:$("compactToggle"), motionToggle:$("motionToggle"), resetData:$("resetData"),
  modal:$("modal"), modalClose:$("modalClose"), modalTitle:$("modalTitle"), modalBody:$("modalBody"), modalKicker:$("modalKicker")
};

const defaultBackend = location.origin;
const state = {
  backend: (localStorage.getItem("jarvis_backend_url") || defaultBackend).replace(/\/$/, ""),
  sessionId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
  history: JSON.parse(localStorage.getItem("jarvis_history") || "[]"),
  memories: JSON.parse(localStorage.getItem("jarvis_memories") || "[]"),
  tasks: JSON.parse(localStorage.getItem("jarvis_tasks") || "[]"),
  files: JSON.parse(localStorage.getItem("jarvis_files") || "[]"),
  attachments: [],
  busy: false,
  currentView: "chat",
  lastHealth: null
};

function saveLocal() {
  localStorage.setItem("jarvis_history", JSON.stringify(state.history.slice(-40)));
  localStorage.setItem("jarvis_memories", JSON.stringify(state.memories.slice(-100)));
  localStorage.setItem("jarvis_tasks", JSON.stringify(state.tasks.slice(-100)));
  localStorage.setItem("jarvis_files", JSON.stringify(state.files.slice(-50)));
}

function setStatus(ok, label) {
  els.statusText.textContent = label;
  els.statusDot.classList.toggle("online", ok);
  els.sideDot.classList.toggle("online", ok);
  els.sideStatus.textContent = label;
  els.sideStatus.className = ok ? "ok" : "";
}

function setView(view) {
  if (!document.getElementById("view-" + view)) return;
  state.currentView = view;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  els.viewLabel.textContent = view.toUpperCase();
  els.sidebar.classList.remove("open");
  els.backdrop.classList.remove("show");
  if (view === "memory") renderMemories();
  if (view === "tasks") renderTasks();
  if (view === "files") renderFiles();
}

function openMenu(open=true) {
  els.sidebar.classList.toggle("open", open);
  els.backdrop.classList.toggle("show", open);
}

function openModal(title, body, kicker="JARVIS TOOL") {
  els.modalKicker.textContent = kicker;
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = body;
  els.modal.classList.add("show");
  els.modal.setAttribute("aria-hidden","false");
}

function closeModal() {
  els.modal.classList.remove("show");
  els.modal.setAttribute("aria-hidden","true");
}

function addMessage(text, role, meta="") {
  const el = document.createElement("article");
  el.className = "message " + role;
  const avatar = role === "assistant" ? '<span class="avatar">J</span>' : "";
  el.innerHTML = avatar + '<div><div class="message-text"></div><small></small></div>';
  el.querySelector(".message-text").textContent = text;
  el.querySelector("small").textContent = meta;
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return el.querySelector(".message-text");
}

function restoreChat() {
  els.messages.innerHTML = "";
  for (const item of state.history) addMessage(item.text, item.role, item.role === "assistant" ? "JARVIS" : "YOU");
}

function resetChat() {
  state.sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  state.history = [];
  saveLocal();
  restoreChat();
  els.coreState.textContent = "STANDBY";
  setView("chat");
  els.input.focus();
}

async function checkHealth() {
  try {
    const res = await fetch(state.backend + "/health", {cache:"no-store"});
    const data = await res.json();
    state.lastHealth = data;
    const ok = Boolean(res.ok && data.ok);
    setStatus(ok, ok ? "ONLINE" : "DEGRADED");
    els.sideModel.textContent = String(data.model || "MODEL UNKNOWN").toUpperCase();
    els.dashCore.textContent = ok ? "ONLINE" : "DEGRADED";
    els.dashModel.textContent = data.model || "--";
    els.dashTools.textContent = data.tools ?? "--";
    els.dashSession.textContent = "LOCAL";
    els.dashBackend.textContent = ok ? "Online" : "Unavailable";
    els.dashKey.textContent = data.openai_configured ? "Configured" : "Missing";
    els.dashChecked.textContent = new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    return data;
  } catch {
    setStatus(false, "OFFLINE");
    els.sideModel.textContent = "BACKEND UNAVAILABLE";
    els.dashCore.textContent = "OFFLINE";
    els.dashBackend.textContent = "Unavailable";
    return null;
  }
}

async function consumeStream(response, replyEl) {
  if (!response.body) throw new Error("Streaming is unavailable in this browser.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", reply = "";

  const consume = (block) => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      const data = JSON.parse(raw);
      if (data.error) throw new Error(data.error);
      if (data.text) {
        reply += data.text;
        replyEl.textContent = reply;
        els.messages.scrollTop = els.messages.scrollHeight;
      }
    }
  };

  while (true) {
    const {done,value} = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {stream:!done});
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return reply.trim();
}

async function sendMessage(text, mode="chat") {
  if (!text || state.busy) return;
  state.busy = true;
  els.send.disabled = true;
  els.input.value = "";
  const clean = text.trim();
  state.history.push({role:"user",text:clean});
  addMessage(clean,"user","YOU");
  els.coreState.textContent = mode === "search" ? "SEARCHING" : "THINKING";
  const replyEl = addMessage("","assistant","JARVIS");

  try {
    const response = await fetch(state.backend + "/api/chat/stream", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:clean, history:state.history.slice(-20), session_id:state.sessionId, mode})
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "Request failed");
    }
    const reply = await consumeStream(response, replyEl);
    if (!reply) throw new Error("JARVIS returned an empty response.");
    state.history.push({role:"assistant",text:reply});
    saveLocal();
    setStatus(true,"ONLINE");
    els.coreState.textContent = "STANDBY";
  } catch (error) {
    replyEl.closest(".message")?.remove();
    addMessage("JARVIS error: " + error.message,"assistant","ERROR");
    els.coreState.textContent = "ERROR";
    setStatus(false,"ERROR");
  } finally {
    state.busy = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

async function runTool(action) {
  if (!ACTIONS[action]) return;
  if (action === "new-chat") return resetChat();

  if (action === "search") {
    const q = prompt("What should JARVIS search for?");
    if (q?.trim()) { setView("chat"); await sendMessage(q.trim(),"search"); }
    return;
  }

  if (action === "calculator") {
    openModal("Calculator", '<form id="calcForm" class="tool-form"><input id="calcExpr" placeholder="e.g. 250 / 4" autofocus><button class="primary-btn">Calculate</button></form><div id="calcResult" class="result-box">Ready.</div>', "UTILITY");
    $("calcForm").addEventListener("submit", async e => {
      e.preventDefault();
      const expression = $("calcExpr").value.trim();
      try {
        const r = await fetch(state.backend + "/api/tools/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"calculator",arguments:{expression}})});
        const data = await r.json();
        $("calcResult").textContent = data.result ?? data.detail ?? "No result";
      } catch { $("calcResult").textContent = "Calculator unavailable."; }
    });
    return;
  }

  if (action === "calendar") {
    setView("tasks");
    els.taskTitle.focus();
    return;
  }

  if (action === "summarize") {
    const text = prompt("Paste the text you want summarized.");
    if (text?.trim()) { setView("chat"); await sendMessage("Summarize this clearly and keep the important facts:\n\n"+text.trim(),"summarize"); }
    return;
  }

  if (action === "translate") {
    const language = prompt("Translate to which language?");
    if (!language?.trim()) return;
    const text = prompt("Paste the text to translate.");
    if (text?.trim()) { setView("chat"); await sendMessage("Translate the following text into "+language.trim()+". Return only the translation unless a brief clarification is necessary.\n\n"+text.trim(),"translate"); }
    return;
  }

  if (action === "analyze") {
    setView("files");
    els.pageFileInput.focus();
  }
}

function renderMemories() {
  els.memoryList.innerHTML = "";
  if (!state.memories.length) { els.memoryList.innerHTML = '<div class="empty">No saved memories yet.</div>'; return; }
  state.memories.slice().reverse().forEach(item => {
    const row = document.createElement("div"); row.className="list-row";
    row.innerHTML = '<div><b></b><small></small></div><button class="danger-ghost">Delete</button>';
    row.querySelector("b").textContent=item.text;
    row.querySelector("small").textContent=new Date(item.createdAt).toLocaleString();
    row.querySelector("button").onclick=()=>{state.memories=state.memories.filter(x=>x.id!==item.id);saveLocal();renderMemories();};
    els.memoryList.appendChild(row);
  });
}

function renderTasks() {
  els.taskList.innerHTML = "";
  if (!state.tasks.length) { els.taskList.innerHTML = '<div class="empty">No tasks yet.</div>'; return; }
  state.tasks.slice().sort((a,b)=>(a.done-b.done)||String(a.due||"").localeCompare(String(b.due||""))).forEach(item=>{
    const row=document.createElement("div");row.className="list-row "+(item.done?"done":"");
    row.innerHTML='<label class="task-check"><input type="checkbox"><span></span></label><div><b></b><small></small></div><button class="danger-ghost">Delete</button>';
    row.querySelector("input").checked=item.done;
    row.querySelector("b").textContent=item.title;
    row.querySelector("small").textContent=item.due?new Date(item.due).toLocaleString():"No scheduled time";
    row.querySelector("input").onchange=()=>{item.done=row.querySelector("input").checked;saveLocal();renderTasks();};
    row.querySelector("button").onclick=()=>{state.tasks=state.tasks.filter(x=>x.id!==item.id);saveLocal();renderTasks();};
    els.taskList.appendChild(row);
  });
}

function renderFiles() {
  els.fileList.innerHTML="";
  if(!state.files.length){els.fileList.innerHTML='<div class="empty">No analyzed files yet.</div>';return;}
  state.files.slice().reverse().forEach(file=>{
    const row=document.createElement("div");row.className="list-row";
    row.innerHTML='<div><b></b><small></small></div><button class="danger-ghost">Forget</button>';
    row.querySelector("b").textContent=file.name;
    row.querySelector("small").textContent=(file.size/1024).toFixed(1)+" KB • "+new Date(file.createdAt).toLocaleString();
    row.querySelector("button").onclick=()=>{state.files=state.files.filter(x=>x.id!==file.id);saveLocal();renderFiles();};
    els.fileList.appendChild(row);
  });
}

async function analyzeFile(file) {
  if (!file) return;
  openModal("Analyzing "+file.name,'<div class="progress">Uploading file to JARVIS…</div>',"FILES");
  const form=new FormData();form.append("file",file);form.append("prompt","Analyze this file. Give a concise but useful overview, key facts, important sections, and any obvious action items.");
  try{
    const r=await fetch(state.backend+"/api/files/analyze",{method:"POST",body:form});
    const data=await r.json();
    if(!r.ok) throw new Error(data.detail||"File analysis failed");
    state.files.push({id:crypto.randomUUID(),name:file.name,size:file.size,createdAt:new Date().toISOString()});
    saveLocal();renderFiles();
    els.modalBody.innerHTML='<div class="analysis-result"></div><button id="analysisToChat" class="primary-btn">Send result to chat</button>';
    $("analysisToChat").onclick=()=>{closeModal();setView("chat");sendMessage("Here is the file analysis for "+file.name+":\n\n"+data.reply);};
    els.modalBody.querySelector(".analysis-result").textContent=data.reply;
  }catch(error){els.modalBody.innerHTML='<div class="error-box"></div>';els.modalBody.querySelector(".error-box").textContent=error.message;}
}

els.form.addEventListener("submit",e=>{e.preventDefault();sendMessage(els.input.value);});
els.newChat.onclick=resetChat;
els.attach.onclick=()=>els.fileInput.click();
els.fileInput.addEventListener("change",()=>{state.attachments=[...els.fileInput.files];els.attachmentBar.classList.toggle("hidden",!state.attachments.length);els.attachmentBar.innerHTML=state.attachments.map(f=>'<span>'+f.name+'</span>').join("");});
els.statusButton.onclick=checkHealth;
els.menu.onclick=()=>openMenu(true);
els.backdrop.onclick=()=>openMenu(false);
els.modalClose.onclick=closeModal;
document.querySelectorAll("[data-close-modal]").forEach(x=>x.onclick=closeModal);
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal();});

document.querySelectorAll("[data-view]").forEach(btn=>btn.addEventListener("click",()=>setView(btn.dataset.view)));
document.querySelectorAll("[data-action]").forEach(btn=>btn.addEventListener("click",()=>runTool(btn.dataset.action)));

els.memoryForm.addEventListener("submit",e=>{e.preventDefault();const text=els.memoryInput.value.trim();if(!text)return;state.memories.push({id:crypto.randomUUID(),text,createdAt:new Date().toISOString()});els.memoryInput.value="";saveLocal();renderMemories();});
els.taskForm.addEventListener("submit",e=>{e.preventDefault();const title=els.taskTitle.value.trim();if(!title)return;state.tasks.push({id:crypto.randomUUID(),title,due:els.taskDue.value||null,done:false});els.taskTitle.value="";els.taskDue.value="";saveLocal();renderTasks();});
els.analyzePageFile.onclick=()=>{const file=els.pageFileInput.files?.[0]; if(file) analyzeFile(file); else alert("Select a file first.");};
els.pageFileInput.addEventListener("change",()=>{const file=els.pageFileInput.files?.[0];if(file) els.analyzePageFile.textContent="Analyze "+file.name;});

els.backendUrlInput.value=state.backend;
els.saveBackend.onclick=()=>{const value=els.backendUrlInput.value.trim().replace(/\/$/,""); if(!/^https?:\/\//i.test(value)){alert("Enter a valid http(s) backend URL.");return;} state.backend=value;localStorage.setItem("jarvis_backend_url",value);checkHealth();};
els.testConnection.onclick=checkHealth;
els.compactToggle.onchange=()=>document.body.classList.toggle("compact",els.compactToggle.checked);
els.motionToggle.onchange=()=>document.body.classList.toggle("reduced-motion",els.motionToggle.checked);
els.resetData.onclick=()=>{if(confirm("Reset local chats, memories, tasks, and file history?")){localStorage.removeItem("jarvis_history");localStorage.removeItem("jarvis_memories");localStorage.removeItem("jarvis_tasks");localStorage.removeItem("jarvis_files");location.reload();}};

function clock(){els.systemTime.textContent=new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});}
setInterval(clock,1000);clock();
restoreChat();renderMemories();renderTasks();renderFiles();checkHealth();
if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
els.input.focus();