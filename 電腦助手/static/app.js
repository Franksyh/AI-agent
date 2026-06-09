const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const storageKey = "future-assistant-ui";
const remoteStorageKey = "future-assistant-remote";

const fallbackWorkflows = [
  {
    icon: "radio-tower",
    title: "跨裝置遠端連線",
    text: "建立配對碼，讓手機、電腦與網頁版加入同一個 session。",
    goal: "支援手機版、電腦版與網頁版遠端連線功能",
  },
  {
    icon: "send",
    title: "客戶信件處理",
    text: "讀取信件、辨識需求、產生回覆草稿、建立待辦事項。",
    goal: "收到客戶信件後，自動分析內容、產生回覆草稿並建立待辦事項",
  },
  {
    icon: "chart-no-axes-combined",
    title: "市場研究摘要",
    text: "收集資料、分群比較、整理重點、輸出報告大綱。",
    goal: "整理 AI Agent 市場研究，產出競品比較表與三段式摘要",
  },
  {
    icon: "rocket",
    title: "網站發布流程",
    text: "檢查檔案、提交 GitHub、部署 Netlify、驗證公開網址。",
    goal: "將目前資料夾同步至 GitHub 並部署到 Netlify，完成後回傳公開連結",
  },
  {
    icon: "file-check-2",
    title: "文件處理",
    text: "摘要文件、抽出待辦、改寫語氣、產生簡報架構。",
    goal: "摘要上傳文件，整理重點、風險與下一步行動",
  },
  {
    icon: "shield-check",
    title: "安全審核",
    text: "標記高風險操作、列出確認點、保留可追溯紀錄。",
    goal: "審核一組自動化流程，標記風險、確認點與回復方案",
  },
];

const state = {
  mode: "confirm",
  apiOnline: false,
  apiInfo: null,
  currentPlan: [],
  workflows: fallbackWorkflows,
  remotePollTimer: null,
  remoteHeartbeatTimer: null,
  remoteCursor: 0,
  remoteSession: null,
  settings: {
    voiceReplies: true,
    largeText: false,
    highContrast: false,
    reducedMotion: false,
  },
};

const modeContent = {
  observe: ["觀察模式", "Agent 只整理資訊與建議，不會執行外部操作。"],
  confirm: ["確認模式", "高影響操作會先列出計畫，再由你確認。"],
  execute: ["執行模式", "低風險步驟可直接執行，高風險步驟仍會保留確認。"],
};

function loadSettings() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    Object.assign(state.settings, parsed.settings || {});
    if (parsed.mode) state.mode = parsed.mode;
  } catch {
    localStorage.removeItem(storageKey);
  }
}

function persistSettings() {
  localStorage.setItem(storageKey, JSON.stringify({ settings: state.settings, mode: state.mode }));
}

function loadRemoteSession() {
  const params = new URLSearchParams(location.search);
  const sessionCode = params.get("session");
  if (sessionCode) {
    $("#joinCode").value = sessionCode.toUpperCase();
    routeTo("remote");
  }

  const saved = localStorage.getItem(remoteStorageKey);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (parsed.sessionId && parsed.token) {
      state.remoteSession = parsed;
      state.remoteCursor = Number(parsed.cursor || 0);
      renderRemoteSession();
      startRemoteLoop();
    }
  } catch {
    localStorage.removeItem(remoteStorageKey);
  }
}

function saveRemoteSession() {
  if (!state.remoteSession) {
    localStorage.removeItem(remoteStorageKey);
    return;
  }
  localStorage.setItem(
    remoteStorageKey,
    JSON.stringify({
      sessionId: state.remoteSession.sessionId,
      code: state.remoteSession.code,
      token: state.remoteSession.token,
      deviceId: state.remoteSession.deviceId,
      role: state.remoteSession.role,
      cursor: state.remoteCursor,
    }),
  );
}

function applySettings() {
  document.body.classList.toggle("large-text", state.settings.largeText);
  document.body.classList.toggle("high-contrast", state.settings.highContrast);
  document.body.classList.toggle("reduced-motion", state.settings.reducedMotion);

  $("#voiceReplies").checked = state.settings.voiceReplies;
  $("#largeText").checked = state.settings.largeText;
  $("#highContrast").checked = state.settings.highContrast;
  $("#reducedMotion").checked = state.settings.reducedMotion;

  const modeInput = $(`input[name="mode"][value="${state.mode}"]`);
  if (modeInput) modeInput.checked = true;
  updateModeCopy();
}

function updateModeCopy() {
  const [title, copy] = modeContent[state.mode] || modeContent.confirm;
  $("#modeTitle").textContent = title;
  $("#modeCopy").textContent = copy;
}

function routeTo(route) {
  $$(".rail-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.route === route);
  });
  $$(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === route);
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "動態 API 回應失敗");
  }
  return data;
}

async function checkDynamicApi() {
  try {
    const data = await api("/api/state");
    state.apiOnline = Boolean(data.dynamic);
    state.apiInfo = data;
  } catch {
    state.apiOnline = false;
    state.apiInfo = null;
  }

  renderConnection();
  renderSystemInfo();
}

function renderConnection() {
  const dot = $("#connectionDot");
  dot.classList.toggle("online", state.apiOnline);
  dot.classList.toggle("offline", !state.apiOnline);
  $("#connectionStatus").textContent = state.apiOnline ? "動態 API 已連線" : "瀏覽器備援模式";
  $("#apiModeMetric").textContent = state.apiOnline ? "Dynamic" : "Fallback";
}

function renderSystemInfo() {
  const data = {
    網站模式: state.apiOnline ? "Netlify 動態網站" : "瀏覽器備援模式",
    API: state.apiInfo?.runtime || "未連線",
    版本: state.apiInfo?.apiVersion || "local-fallback",
    遠端連線: state.apiInfo?.capabilities?.remoteSessions ? "支援" : "未確認",
    RequestID: state.apiInfo?.requestId || "無",
    伺服器時間: state.apiInfo?.serverTime ? formatDateTime(state.apiInfo.serverTime) : "無",
    GitHub: "Franksyh/AI-agent",
    Netlify: "franksyh-ai-agent.netlify.app",
  };

  const info = $("#systemInfo");
  info.innerHTML = "";
  Object.entries(data).forEach(([key, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    info.append(dt, dd);
  });
}

async function loadWorkflows() {
  try {
    const data = await api("/api/workflows");
    state.workflows = data.workflows || fallbackWorkflows;
  } catch {
    state.workflows = fallbackWorkflows;
  }
  renderWorkflows();
}

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  $("#messages").appendChild(node);
  $("#messages").scrollTop = $("#messages").scrollHeight;

  if (role === "system" && state.settings.voiceReplies) {
    speak(text);
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 260));
  utterance.lang = "zh-TW";
  utterance.rate = 1;
  speechSynthesis.speak(utterance);
}

async function handleChat(event) {
  event.preventDefault();
  const input = $("#promptInput");
  const message = input.value.trim();
  if (!message) return;

  input.value = "";
  addMessage("user", message);

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, mode: state.mode }),
    });
    state.apiOnline = true;
    state.apiInfo = { ...state.apiInfo, requestId: data.requestId, serverTime: data.generatedAt };
    renderConnection();
    renderSystemInfo();
    addMessage("system", data.reply);
    if (data.plan) setPlan(data.plan);
  } catch {
    state.apiOnline = false;
    renderConnection();
    const plan = createFallbackPlan(message);
    addMessage("system", buildFallbackReply(message, plan));
    setPlan(plan);
  }
}

async function buildPlanFromInput() {
  const goal = $("#goalInput").value.trim() || "支援手機版、電腦版與網頁版遠端連線功能";
  try {
    const data = await api("/api/plan", {
      method: "POST",
      body: JSON.stringify({ goal, mode: state.mode }),
    });
    state.apiOnline = true;
    state.apiInfo = { ...state.apiInfo, requestId: data.requestId, serverTime: data.generatedAt };
    renderConnection();
    renderSystemInfo();
    setPlan(data.plan);
  } catch {
    state.apiOnline = false;
    renderConnection();
    setPlan(createFallbackPlan(goal));
  }
}

function setPlan(plan) {
  state.currentPlan = Array.isArray(plan) ? plan : [];
  renderPlan();
  routeTo("planner");
}

function renderPlan() {
  const board = $("#planBoard");
  board.innerHTML = "";
  let count = 0;

  state.currentPlan.forEach((column, columnIndex) => {
    const article = document.createElement("article");
    article.className = "plan-column";
    article.innerHTML = `
      <header>
        <h3>${escapeHtml(column.phase)}</h3>
        <small>${column.steps.length} 步</small>
      </header>
      <div class="step-list"></div>
    `;
    const list = article.querySelector(".step-list");
    column.steps.forEach((step, stepIndex) => {
      count += 1;
      const label = document.createElement("label");
      label.className = "step-item";
      label.innerHTML = `
        <input type="checkbox" data-column="${columnIndex}" data-step="${stepIndex}" />
        <span>${escapeHtml(step)}</span>
      `;
      label.querySelector("input").addEventListener("change", (event) => {
        label.classList.toggle("done", event.currentTarget.checked);
      });
      list.appendChild(label);
    });
    board.appendChild(article);
  });

  $("#planCount").textContent = String(count);
}

function planMarkdown() {
  if (!state.currentPlan.length) return "# Future Assistant Plan\n\n尚未產生計畫。\n";
  return state.currentPlan
    .map((column) => [`## ${column.phase}`, ...column.steps.map((step) => `- ${step}`)].join("\n"))
    .join("\n\n");
}

async function copyPlan() {
  await navigator.clipboard.writeText(planMarkdown());
  addMessage("system", "計畫已複製到剪貼簿。");
}

function downloadPlan() {
  const blob = new Blob([planMarkdown()], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "future-assistant-plan.md";
  link.click();
  URL.revokeObjectURL(url);
}

async function createRemoteSession() {
  try {
    const data = await remoteApi("create", {
      deviceName: getDeviceName(),
      deviceType: $("#deviceType").value,
    });
    attachRemoteSession(data);
    routeTo("remote");
    addRemoteEvent("系統", "已建立主控連線，手機或網頁版可用配對碼加入。");
  } catch (error) {
    addRemoteEvent("錯誤", error.message);
  }
}

async function joinRemoteSession() {
  const code = $("#joinCode").value.trim().toUpperCase();
  if (!code) {
    addRemoteEvent("提醒", "請先輸入配對碼。");
    return;
  }

  try {
    const data = await remoteApi("join", {
      code,
      deviceName: getDeviceName(),
      deviceType: $("#deviceType").value,
    });
    attachRemoteSession(data);
    routeTo("remote");
    addRemoteEvent("系統", "已加入遠端 session。");
  } catch (error) {
    addRemoteEvent("錯誤", error.message);
  }
}

async function remoteApi(action, payload = {}) {
  return api("/api/remote", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  });
}

function attachRemoteSession(data) {
  state.apiOnline = true;
  state.remoteSession = {
    sessionId: data.session.id,
    code: data.session.code,
    token: data.token,
    deviceId: data.deviceId,
    role: data.role,
    session: data.session,
  };
  state.remoteCursor = data.cursor || data.session.sequence || 0;
  saveRemoteSession();
  renderConnection();
  renderRemoteSession();
  startRemoteLoop();
}

function startRemoteLoop() {
  stopRemoteLoop();
  pollRemoteSession();
  state.remoteHeartbeatTimer = setInterval(sendHeartbeat, 15000);
  state.remotePollTimer = setInterval(pollRemoteSession, 5000);
}

function stopRemoteLoop() {
  clearInterval(state.remoteHeartbeatTimer);
  clearInterval(state.remotePollTimer);
  state.remoteHeartbeatTimer = null;
  state.remotePollTimer = null;
}

async function sendHeartbeat() {
  if (!state.remoteSession) return;
  try {
    await remoteApi("heartbeat", {
      sessionId: state.remoteSession.sessionId,
      token: state.remoteSession.token,
      deviceName: getDeviceName(),
      deviceType: $("#deviceType").value,
    });
  } catch {
    $("#remoteStatusBadge").textContent = "等待重連";
  }
}

async function pollRemoteSession() {
  if (!state.remoteSession) return;
  try {
    const data = await remoteApi("poll", {
      sessionId: state.remoteSession.sessionId,
      token: state.remoteSession.token,
      cursor: state.remoteCursor,
    });
    state.remoteSession.session = data.session;
    state.remoteCursor = data.cursor;
    saveRemoteSession();
    renderRemoteSession();
    (data.events || []).forEach((event) => addRemoteEvent(event.fromName || event.type, event.message || event.payload?.text || event.commandType));
  } catch (error) {
    $("#remoteStatusBadge").textContent = "連線中斷";
    addRemoteEvent("錯誤", error.message);
  }
}

async function sendRemoteCommand() {
  if (!state.remoteSession) {
    addRemoteEvent("提醒", "請先建立或加入遠端 session。");
    return;
  }

  const commandType = $("#commandType").value;
  const text = $("#remoteCommand").value.trim() || (commandType === "ping" ? "連線測試" : "");
  if (!text && commandType !== "ping") return;

  try {
    const data = await remoteApi("send", {
      sessionId: state.remoteSession.sessionId,
      token: state.remoteSession.token,
      commandType,
      target: "all",
      payload: {
        text,
        url: commandType === "open_url" ? text : "",
      },
    });
    state.remoteSession.session = data.session;
    state.remoteCursor = data.cursor;
    $("#remoteCommand").value = "";
    renderRemoteSession();
    addRemoteEvent("已送出", text || commandType);
  } catch (error) {
    addRemoteEvent("錯誤", error.message);
  }
}

function renderRemoteSession() {
  const remote = state.remoteSession;
  const session = remote?.session;
  const devices = session?.devices || [];
  const joinUrl = session ? `${location.origin}${location.pathname}?session=${encodeURIComponent(session.code)}` : "";

  $("#remoteMetric").textContent = String(devices.length);
  $("#remoteStatusBadge").textContent = session ? session.status === "closed" ? "已關閉" : "已連線" : "未連線";
  $("#pairCode").textContent = session?.code || "尚未建立";
  $("#joinLink").textContent = joinUrl || "建立 session 後會產生網址。";

  const qr = $("#qrImage");
  if (joinUrl) {
    qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(joinUrl)}`;
    qr.hidden = false;
  } else {
    qr.removeAttribute("src");
    qr.hidden = true;
  }

  const list = $("#deviceList");
  list.innerHTML = "";
  if (!devices.length) {
    list.innerHTML = `<div class="result-box">尚未連線裝置。</div>`;
    return;
  }

  devices.forEach((device) => {
    const item = document.createElement("article");
    item.className = "device-item";
    item.innerHTML = `
      <i data-lucide="${deviceIcon(device.type)}"></i>
      <div>
        <strong>${escapeHtml(device.name)}</strong>
        <small>${escapeHtml(deviceLabel(device.type))} · ${escapeHtml(device.role)} · ${device.online ? "在線" : "離線"}</small>
      </div>
    `;
    list.appendChild(item);
  });
  refreshIcons();
}

async function copyJoinLink() {
  const session = state.remoteSession?.session;
  if (!session) return;
  const joinUrl = `${location.origin}${location.pathname}?session=${encodeURIComponent(session.code)}`;
  await navigator.clipboard.writeText(joinUrl);
  addRemoteEvent("系統", "連線網址已複製。");
}

function addRemoteEvent(title, detail) {
  const log = $("#remoteEvents");
  const node = document.createElement("div");
  node.className = "event-item";
  node.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(detail || "")}</span>
    <small>${new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}</small>
  `;
  log.prepend(node);
}

function getDeviceName() {
  const input = $("#deviceName");
  const name = input.value.trim();
  if (name) return name;
  const fallback = $("#deviceType").value === "mobile" ? "手機版裝置" : $("#deviceType").value === "desktop" ? "電腦版裝置" : "網頁版裝置";
  input.value = fallback;
  return fallback;
}

function deviceIcon(type) {
  if (type === "mobile") return "smartphone";
  if (type === "desktop") return "monitor";
  return "globe-2";
}

function deviceLabel(type) {
  if (type === "mobile") return "手機版";
  if (type === "desktop") return "電腦版";
  return "網頁版";
}

function renderWorkflows() {
  const grid = $("#workflowGrid");
  grid.innerHTML = "";
  state.workflows.forEach((workflow) => {
    const card = document.createElement("article");
    card.className = "workflow-card";
    card.innerHTML = `
      <header>
        <i data-lucide="${workflow.icon}"></i>
        <h3>${escapeHtml(workflow.title)}</h3>
      </header>
      <p>${escapeHtml(workflow.text)}</p>
      <button type="button">
        <i data-lucide="plus"></i>
        <span>建立計畫</span>
      </button>
    `;
    card.querySelector("button").addEventListener("click", async () => {
      $("#goalInput").value = workflow.goal;
      await buildPlanFromInput();
      addMessage("system", `已建立「${workflow.title}」的動態流程計畫。`);
    });
    grid.appendChild(card);
  });
  refreshIcons();
}

function handleQuickAction(intent) {
  const map = {
    remote: "支援手機版、電腦版與網頁版遠端連線功能",
    "github-netlify": "將目前資料夾同步至 GitHub 並部署到 Netlify，完成後回傳公開連結",
    research: "整理 AI Agent 產品趨勢，產生比較表與重點摘要",
    document: "摘要一份產品介紹文件，整理成簡報大綱",
  };
  $("#goalInput").value = map[intent] || "規劃一個 AI Agent 工作流程";
  if (intent === "remote") routeTo("remote");
  buildPlanFromInput();
}

async function summarizeFile(file) {
  const summary = $("#fileSummary");
  if (!file) {
    summary.textContent = "尚未選擇檔案。";
    return;
  }

  const text = await file.text();
  try {
    const data = await api("/api/brief", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        text: text.slice(0, 20000),
      }),
    });
    state.apiOnline = true;
    state.apiInfo = { ...state.apiInfo, requestId: data.requestId, serverTime: data.generatedAt };
    renderConnection();
    renderSystemInfo();
    summary.textContent = formatBrief(file, data.brief, true);
  } catch {
    state.apiOnline = false;
    renderConnection();
    summary.textContent = formatBrief(file, createLocalBrief(text), false);
  }
}

function formatBrief(file, brief, dynamic) {
  const keywords = brief.keywords?.length
    ? brief.keywords.map((item) => `${item.keyword} (${item.count})`).join("、")
    : "無";
  const actions = brief.actionItems?.length ? brief.actionItems.map((item) => `- ${item}`).join("\n") : "無";
  const summary = brief.summary?.length ? brief.summary.map((item) => `- ${item}`).join("\n") : "無";

  return [
    `模式：${dynamic ? "Netlify 動態摘要" : "瀏覽器本機摘要"}`,
    `檔名：${file.name}`,
    `大小：${formatBytes(file.size)}`,
    `行數：${brief.lineCount}`,
    `字元數：${brief.charCount}`,
    "",
    "重點摘要：",
    summary,
    "",
    "可能關鍵字：",
    keywords,
    "",
    "待辦線索：",
    actions,
  ].join("\n");
}

function createLocalBrief(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n").filter(Boolean);
  const sentences = normalized.split(/[。.!?\n]/).map((item) => item.trim()).filter(Boolean);
  return {
    lineCount: lines.length,
    wordCount: normalized ? normalized.split(/\s+/).length : 0,
    charCount: normalized.length,
    summary: sentences.slice(0, 3),
    actionItems: lines.filter((line) => /待辦|下一步|需要|請|必須|todo|should|must/i.test(line)).slice(0, 6),
    keywords: [],
  };
}

function openSearch() {
  const query = $("#searchInput").value.trim();
  if (!query) return;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  $("#searchBrief").textContent = `研究主題：${query}\n搜尋頁已在新分頁開啟。`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $("#voiceButton");
  if (!SpeechRecognition) {
    button.disabled = true;
    button.title = "此瀏覽器未支援語音輸入";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-TW";
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.addEventListener("result", (event) => {
    $("#promptInput").value = event.results[0][0].transcript;
    $("#chatForm").requestSubmit();
  });

  recognition.addEventListener("end", () => button.classList.remove("active"));
  button.addEventListener("click", () => {
    button.classList.add("active");
    recognition.start();
  });
}

function setupEvents() {
  $$(".rail-button").forEach((button) => {
    button.addEventListener("click", () => routeTo(button.dataset.route));
  });

  $("#chatForm").addEventListener("submit", handleChat);
  $("#buildPlan").addEventListener("click", buildPlanFromInput);
  $("#copyPlan").addEventListener("click", copyPlan);
  $("#downloadPlan").addEventListener("click", downloadPlan);
  $("#fileInput").addEventListener("change", (event) => summarizeFile(event.target.files[0]));
  $("#openSearch").addEventListener("click", openSearch);
  $("#createSession").addEventListener("click", createRemoteSession);
  $("#joinSession").addEventListener("click", joinRemoteSession);
  $("#copyJoinLink").addEventListener("click", copyJoinLink);
  $("#sendRemoteCommand").addEventListener("click", sendRemoteCommand);

  $$("input[name='mode']").forEach((input) => {
    input.addEventListener("change", (event) => {
      state.mode = event.target.value;
      persistSettings();
      updateModeCopy();
    });
  });

  $$(".quick-actions button").forEach((button) => {
    button.addEventListener("click", () => handleQuickAction(button.dataset.intent));
  });

  ["voiceReplies", "largeText", "highContrast", "reducedMotion"].forEach((id) => {
    $(`#${id}`).addEventListener("change", (event) => {
      state.settings[id] = event.target.checked;
      persistSettings();
      applySettings();
    });
  });
}

function refreshClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function createFallbackPlan(goal) {
  const text = goal.trim() || "支援手機版、電腦版與網頁版遠端連線功能";
  const lower = text.toLowerCase();
  const remote = text.includes("遠端") || text.includes("手機") || text.includes("電腦") || text.includes("網頁");
  const deploy = lower.includes("github") || lower.includes("netlify") || text.includes("部署") || text.includes("同步");
  const research = text.includes("研究") || text.includes("搜尋") || text.includes("比較");
  const documentTask = text.includes("文件") || text.includes("摘要") || text.includes("簡報");

  if (remote) {
    return [
      { phase: "建立連線", steps: ["電腦版建立主控 session", "產生配對碼與 QR code", "保存 session token"] },
      { phase: "跨裝置加入", steps: ["手機版用配對碼加入", "網頁版用連線網址加入", "顯示裝置類型與在線狀態"] },
      { phase: "同步狀態", steps: ["定期送出心跳", "輪詢遠端事件", "更新裝置清單與指令佇列"] },
      { phase: "安全控制", steps: ["每台裝置使用獨立 token", "高風險操作保留人工確認", "可關閉或重建 session"] },
    ];
  }

  if (deploy) {
    return [
      { phase: "檢查", steps: ["確認工作區狀態", "檢查首頁、動態 API 與靜態資源", "排除不應上傳的本機檔案"] },
      { phase: "提交", steps: ["建立清楚的 commit", "推送到 GitHub main", "確認遠端 commit 與本機一致"] },
      { phase: "部署", steps: ["使用既有 Netlify site", "部署 Netlify Functions 與前端檔案", "等待 production deploy ready"] },
      { phase: "驗證", steps: ["檢查公開首頁 HTTP 200", "呼叫 /api/state 確認動態 API", "回傳 GitHub 與 Netlify 連結"] },
    ];
  }

  if (research) {
    return [
      { phase: "定義", steps: ["確認研究問題", "列出比較條件", "決定輸出格式"] },
      { phase: "蒐集", steps: ["搜尋主要來源", "記錄可信來源", "標記日期與限制"] },
      { phase: "整理", steps: ["分群重點", "建立比較表", "寫出結論摘要"] },
      { phase: "交付", steps: ["產出報告", "補上引用", "列出下一步"] },
    ];
  }

  if (documentTask) {
    return [
      { phase: "讀取", steps: ["匯入文件", "辨識章節", "抽出關鍵名詞"] },
      { phase: "摘要", steps: ["整理三到五個重點", "標記風險", "萃取待辦"] },
      { phase: "轉換", steps: ["改寫成簡報大綱", "產生表格", "整理成寄送版本"] },
      { phase: "確認", steps: ["檢查語氣", "補齊缺漏", "輸出最終版本"] },
    ];
  }

  return [
    { phase: "理解", steps: [`確認目標：${text}`, "列出限制條件", "定義完成標準"] },
    { phase: "規劃", steps: ["拆解可執行步驟", "排序優先順序", "標記需要確認的節點"] },
    { phase: "執行", steps: ["處理低風險步驟", "保存中間結果", "回報阻塞事項"] },
    { phase: "交付", steps: ["整理成果", "驗證輸出", "提供下一步建議"] },
  ];
}

function buildFallbackReply(message, plan) {
  const stepCount = plan.reduce((sum, item) => sum + item.steps.length, 0);
  return `目前使用瀏覽器備援邏輯。我已把「${message}」拆成 ${plan.length} 個階段、${stepCount} 個步驟。`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(size || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDateTime(value) {
  try {
    return new Date(value).toLocaleString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  loadSettings();
  applySettings();
  setupEvents();
  setupVoiceInput();
  loadRemoteSession();
  refreshClock();
  setInterval(refreshClock, 1000);

  await checkDynamicApi();
  await loadWorkflows();
  await buildPlanFromInput();
  routeTo(new URLSearchParams(location.search).has("session") ? "remote" : "overview");

  addMessage(
    "system",
    state.apiOnline
      ? "歡迎使用 Future Assistant。現在已連上 Netlify 動態 API，遠端連線、任務計畫與摘要會由伺服器即時產生。"
      : "歡迎使用 Future Assistant。目前使用瀏覽器備援模式，部署後會自動切換到 Netlify 動態 API。",
  );
  refreshIcons();
});
