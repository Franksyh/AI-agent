
const $ = (id) => document.getElementById(id);
const STORAGE = "mini-codex-cloud-v1";
const SCALES = [0.8, 0.9, 1, 1.15, 1.3];

const state = {
  chats: [],
  currentId: null,
  plan: [],
  sources: [],
  providers: [],
  access: null,
  online: false,
  working: false,
  settings: { scale: 1, speech: false, plan: "free", miniHidden: false },
};

function id() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "{}");
    state.chats = Array.isArray(saved.chats) ? saved.chats.slice(0, 20) : [];
    state.currentId = state.chats.some((chat) => chat.id === saved.currentId) ? saved.currentId : state.chats[0]?.id || null;
    state.settings = { ...state.settings, ...(saved.settings || {}) };
  } catch {
    localStorage.removeItem(STORAGE);
  }
}

function persist() {
  localStorage.setItem(STORAGE, JSON.stringify({
    chats: state.chats.slice(0, 20),
    currentId: state.currentId,
    settings: state.settings,
  }));
}

function currentChat() {
  return state.chats.find((chat) => chat.id === state.currentId) || null;
}

function createChat() {
  const chat = { id: id(), title: "新對話", messages: [], plan: [], createdAt: new Date().toISOString() };
  state.chats.unshift(chat);
  state.currentId = chat.id;
  state.plan = [];
  persist();
  render();
  $("prompt").focus();
}

function selectChat(chatId) {
  if (!state.chats.some((chat) => chat.id === chatId)) return;
  state.currentId = chatId;
  state.plan = currentChat()?.plan || [];
  persist();
  render();
  closeMobilePanels();
}

function setScale(value) {
  const scale = SCALES.reduce((closest, candidate) => Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest, 1);
  state.settings.scale = scale;
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  document.body.style.zoom = String(scale);
  $("scale").value = String(scale);
  persist();
}

function showNotice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}

function closeMobilePanels() {
  $("history-drawer").classList.remove("mobile-open");
  $("inspector").classList.remove("mobile-open");
}

function renderHistory() {
  const history = $("history");
  history.replaceChildren(...state.chats.map((chat) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-item${chat.id === state.currentId ? " active" : ""}`;
    button.textContent = chat.title || "未命名對話";
    button.title = button.textContent;
    button.addEventListener("click", () => selectChat(chat.id));
    return button;
  }));
  if (!state.chats.length) {
    const empty = document.createElement("p");
    empty.className = "status-copy";
    empty.textContent = "還沒有對話，開始第一個任務吧。";
    history.append(empty);
  }
  $("chat-count").textContent = String(state.chats.length);
}

function createMessage(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  const role = document.createElement("div");
  role.className = "message-role";
  role.textContent = message.role === "user" ? "YOU" : "✦ MINI";
  const body = document.createElement("div");
  body.textContent = message.text;
  article.append(role, body);
  if (message.meta) {
    const meta = document.createElement("div");
    meta.className = "reply-meta";
    meta.textContent = message.meta;
    article.append(meta);
  }
  return article;
}

function renderMessages() {
  const chat = currentChat();
  const messages = $("messages");
  messages.replaceChildren(...(chat?.messages || []).map(createMessage));
  $("welcome").hidden = Boolean(chat?.messages?.length);
  $("pet-status").textContent = state.working ? "正在整理中…" : chat?.messages?.length ? "隨時可以繼續" : "準備開始";
  $("pet-copy").textContent = state.working ? "工作計畫會即時更新。" : chat?.messages?.length ? "你的對話保留在這個瀏覽器。" : "你的下一個想法，我陪你完成。";
}

function normalizedPlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((phase) => {
    const heading = safeText(phase?.phase, "");
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    return steps.map((step, index) => ({ heading: index === 0 ? heading : "", step: safeText(step, "待確認步驟") }));
  });
}

function renderPlan() {
  const chat = currentChat();
  const plan = chat?.plan || state.plan || [];
  const rows = normalizedPlan(plan);
  const target = $("plan");
  target.replaceChildren(...(rows.length ? rows.map((row) => {
    const item = document.createElement("li");
    item.textContent = row.heading ? `${row.heading}：${row.step}` : row.step;
    return item;
  }) : [Object.assign(document.createElement("li"), { className: "empty", textContent: "送出需求後，計畫會顯示在這裡。" })]));
  $("session-status").textContent = chat?.messages?.length
    ? `這個對話有 ${chat.messages.length} 則訊息，僅保存在目前瀏覽器。`
    : "這些紀錄儲存在此瀏覽器；不會匯入你的 Codex 對話。";
}

function sourceScore(source) {
  const value = Number(source?.score ?? source?.qualityScore ?? 0);
  if (Number.isFinite(value) && value > 0) return `${Math.round(value)}/100`;
  if (source?.reviewStatus === "owner_review_required") return "待擁有者審查";
  if (source?.metadataStatus === "live") return "公開資料已更新";
  return "待審查";
}

function renderSources() {
  const sources = state.sources;
  $("source-summary").textContent = sources.length
    ? `已載入 ${sources.length} 個受信任來源。公開資料是快速篩選，變更必須由本機擁有者審查。`
    : "目前無法讀取來源資料；仍可在本機 Mini 手動檢查。";

  const mini = $("source-mini-list");
  mini.replaceChildren(...sources.slice(0, 4).map((source) => {
    const row = document.createElement("div");
    row.className = "mini-row";
    const title = document.createElement("strong");
    title.textContent = safeText(source.name, source.repository || "來源");
    const description = document.createElement("span");
    description.textContent = `${sourceScore(source)} · ${safeText(source.description, safeText(source.note, "等待公開資料"))}`;
    row.append(title, description);
    return row;
  }));

  const list = $("source-list");
  list.replaceChildren(...sources.map((source) => {
    const card = document.createElement("article");
    card.className = "source-card";
    const head = document.createElement("div");
    head.className = "source-card-head";
    const left = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = safeText(source.name, source.repository || "未命名來源");
    const info = document.createElement("small");
    info.textContent = [source.repository, source.license, source.defaultBranch || source.default_branch].filter(Boolean).join(" · ") || "公開來源";
    left.append(name, info);
    const score = document.createElement("span");
    score.className = "source-score";
    score.textContent = sourceScore(source);
    head.append(left, score);
    const description = document.createElement("small");
    description.textContent = safeText(source.description, safeText(source.note, "沒有可用更新訊息。"));
    const links = document.createElement("div");
    links.className = "source-links";
    const checked = document.createElement("span");
    checked.textContent = source.latestPushAt || source.checked_at
      ? `更新：${formatDate(source.latestPushAt || source.checked_at)}`
      : "等待檢查";
    links.append(checked);
    if (source.url) {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "開啟來源 ↗";
      links.append(link);
    }
    card.append(head, description, links);
    return card;
  }));
  const generated = state.sourceGeneratedAt ? `上次載入：${formatDate(state.sourceGeneratedAt)}` : "";
  $("source-checked-at").textContent = generated;
}

function renderProviders() {
  const list = $("provider-list");
  list.replaceChildren(...state.providers.map((provider) => {
    const card = document.createElement("article");
    card.className = "provider-card";
    const head = document.createElement("div");
    head.className = "provider-card-head";
    const left = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = safeText(provider.name, "服務");
    const summary = document.createElement("small");
    summary.textContent = safeText(provider.description, safeText(provider.capability, "需要設定"));
    left.append(name, summary);
    const status = document.createElement("span");
    status.className = "provider-state";
    const labels = {
      local_companion_required: "需要本機 Mini",
      public_metadata_only: "僅公開資料",
      not_configured: "需要設定",
      reference_only: "僅供參考",
      self_hosting_required: "需要自建環境",
    };
    status.textContent = safeText(provider.statusLabel, labels[provider.status] || safeText(provider.status, "需要設定"));
    head.append(left, status);
    card.append(head);
    list.append(card);
  }));
  if (!state.providers.length) {
    const item = document.createElement("p");
    item.className = "status-copy";
    item.textContent = "服務狀態暫時不可用。公開網站不會要求 API 金鑰。";
    list.append(item);
  }
}

function renderAccess() {
  const access = state.access || {};
  const role = safeText(access.publicRole, "一般使用者");
  const panel = $("access-panel");
  const owner = document.createElement("div");
  owner.className = "access-card";
  owner.innerHTML = "<strong>擁有者（Frank 的本機 Mini）</strong>讀取、編輯、來源審查、工具核准與電腦協助，均需在 Windows 本機工作台中啟用與核准。";
  const member = document.createElement("div");
  member.className = "access-card";
  member.innerHTML = `<strong>${role}</strong>${safeText(access.publicDescription, "可使用規劃、閱讀公開來源與提出協作請求，不能取得本機檔案或電腦控制。")}`;
  panel.replaceChildren(owner, member);
  $("access-badge").textContent = `${role} · 使用與讀取`;
}

function render() {
  renderHistory();
  renderMessages();
  renderPlan();
  renderSources();
  renderProviders();
  renderAccess();
  $("working").hidden = !state.working;
  $("compose").querySelector("button[type=submit]").disabled = state.working;
  $("mini-float").hidden = state.settings.miniHidden;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "剛剛" : new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "short" }).format(date);
}

async function request(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "服務暫時無法使用");
  return payload;
}

async function refreshCloudData() {
  const results = await Promise.allSettled([
    request(`/api/state?_=${Date.now()}`),
    request(`/api/sources?_=${Date.now()}`),
    request(`/api/providers?_=${Date.now()}`),
    request(`/api/access?_=${Date.now()}`),
  ]);
  const [server, sources, providers, access] = results;
  state.online = server.status === "fulfilled";
  $("connection-copy").textContent = state.online
    ? `已連線 · ${safeText(server.value.provider, "公開服務")} · 計畫與來源即時更新`
    : "離線備援模式 · 仍可保存本機瀏覽器對話";
  if (sources.status === "fulfilled") {
    state.sources = Array.isArray(sources.value.sources) ? sources.value.sources : [];
    state.sourceGeneratedAt = sources.value.generatedAt;
  }
  if (providers.status === "fulfilled") state.providers = Array.isArray(providers.value.providers) ? providers.value.providers : [];
  if (access.status === "fulfilled") state.access = access.value.access || access.value;
  render();
}

function fallbackPlan(text) {
  return [
    { phase: "理解", steps: [`確認目標：${text}`, "列出範圍與限制", "定義完成標準"] },
    { phase: "規劃", steps: ["拆解可執行步驟", "標記需要擁有者核准的操作", "排序優先順序"] },
    { phase: "交付", steps: ["整理成果", "驗證輸出", "提供下一步建議"] },
  ];
}

function speak(text) {
  if (!state.settings.speech || !("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 700));
  utterance.lang = "zh-TW";
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

async function sendMessage() {
  const prompt = $("prompt");
  const text = prompt.value.trim();
  if (!text || state.working) return;
  let chat = currentChat();
  if (!chat) {
    createChat();
    chat = currentChat();
  }
  chat.messages.push({ role: "user", text });
  chat.title = chat.messages.find((message) => message.role === "user")?.text.slice(0, 26) || "新對話";
  prompt.value = "";
  state.working = true;
  persist();
  render();
  try {
    const data = await request("/api/chat", { method: "POST", body: JSON.stringify({ message: text, mode: $("mode").value }) });
    const response = safeText(data.reply, "已收到需求，請在本機 Mini 繼續審查。");
    chat.messages.push({ role: "assistant", text: response, meta: `${safeText(data.provider, "公開服務")} · ${formatDate(data.generatedAt)}` });
    chat.plan = Array.isArray(data.plan) ? data.plan : fallbackPlan(text);
    state.plan = chat.plan;
    speak(response);
  } catch (error) {
    const plan = fallbackPlan(text);
    const response = "目前無法連線到公開規劃服務。我先在這個瀏覽器建立備援計畫；本機 Mini 仍可用於真正的 Codex 對話與檔案操作。";
    chat.messages.push({ role: "assistant", text: response, meta: "瀏覽器備援" });
    chat.plan = plan;
    state.plan = plan;
    showNotice(error.message);
  } finally {
    state.working = false;
    persist();
    render();
    requestAnimationFrame(() => { $("conversation").scrollTop = $("conversation").scrollHeight; });
  }
}

function startVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    showNotice("這個瀏覽器不支援語音辨識；請使用 Chrome 或 Edge 的語音輸入。");
    return;
  }
  const recognition = new Recognition();
  recognition.lang = "zh-TW";
  recognition.interimResults = true;
  recognition.continuous = false;
  const original = $("prompt").value;
  $("voice-input").textContent = "●";
  recognition.onresult = (event) => {
    const text = Array.from(event.results).map((result) => result[0]?.transcript || "").join("");
    $("prompt").value = `${original}${original && text ? " " : ""}${text}`;
  };
  recognition.onerror = () => showNotice("語音辨識沒有完成，請再試一次。");
  recognition.onend = () => { $("voice-input").textContent = "◉"; $("prompt").focus(); };
  recognition.start();
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === name));
}

function wire() {
  $("new-chat").addEventListener("click", createChat);
  $("compose").addEventListener("submit", (event) => { event.preventDefault(); sendMessage(); });
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("compose").requestSubmit();
    }
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    $("prompt").value = button.dataset.prompt || "";
    $("prompt").focus();
  }));
  $("voice-input").addEventListener("click", startVoiceInput);
  $("panel-button").addEventListener("click", () => $("inspector").classList.add("mobile-open"));
  $("zoom-in").addEventListener("click", () => setScale(state.settings.scale + 0.11));
  $("zoom-out").addEventListener("click", () => setScale(state.settings.scale - 0.11));
  $("open-history").addEventListener("click", () => $("history-drawer").classList.add("mobile-open"));
  $("close-history").addEventListener("click", closeMobilePanels);
  $("close-inspector").addEventListener("click", closeMobilePanels);
  $("sources-button").addEventListener("click", () => $("sources-dialog").showModal());
  $("providers-button").addEventListener("click", () => $("providers-dialog").showModal());
  $("refresh-sources").addEventListener("click", refreshCloudData);
  $("hide-mini").addEventListener("click", () => { state.settings.miniHidden = true; persist(); render(); });
  $("open-local-help").addEventListener("click", () => {
    showNotice("請在 Windows 執行 Start-Mini-Codex.cmd，登入 Codex 後由你核准讀取、編輯或電腦協助。公開網站無法取得這些權限。");
  });
  $("settings-button").addEventListener("click", () => {
    $("scale").value = String(state.settings.scale);
    $("speech-output").checked = state.settings.speech;
    $("show-mini").checked = !state.settings.miniHidden;
    $("plan-choice").value = state.settings.plan;
    $("settings-dialog").showModal();
  });
  $("settings-dialog").addEventListener("close", () => {
    if ($("settings-dialog").returnValue !== "save") return;
    state.settings.speech = $("speech-output").checked;
    state.settings.miniHidden = !$("show-mini").checked;
    state.settings.plan = $("plan-choice").value;
    setScale(Number($("scale").value));
    persist();
    render();
  });
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      createChat();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "=") {
      event.preventDefault();
      setScale(state.settings.scale + 0.11);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "-") {
      event.preventDefault();
      setScale(state.settings.scale - 0.11);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "0") {
      event.preventDefault();
      setScale(1);
    }
  });
}

loadLocal();
setScale(Number(state.settings.scale));
wire();
render();
refreshCloudData();
window.setInterval(refreshCloudData, 5 * 60 * 1000);
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
