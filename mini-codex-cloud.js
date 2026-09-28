
const $ = (id) => document.getElementById(id);
const STORAGE = "mini-codex-cloud-v1";
const SCALES = [0.8, 0.9, 1, 1.15, 1.3];

const state = {
  chats: [],
  currentId: null,
  plan: [],
  sources: [],
  sourceStatus: null,
  providers: [],
  access: null,
  online: false,
  working: false,
  settings: { scale: 1, speech: false, plan: "free", miniHidden: false },
};
let installPrompt = null;
let googleAccessToken = null;
let googleAccessExpiresAt = 0;
let googleContentItems = [];

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
  const baseSummary = sources.length
    ? `已載入 ${sources.length} 個受信任來源。公開資料是快速篩選，變更必須由本機擁有者審查。`
    : "目前無法讀取來源資料；仍可在本機 Mini 手動檢查。";
  $("source-summary").textContent = baseSummary;

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
    const signals = Array.isArray(source.qualitySignals) && source.qualitySignals.length
      ? document.createElement("small")
      : null;
    if (signals) {
      signals.className = "source-signals";
      signals.textContent = `公開指標：${source.qualitySignals.join("、")}`;
    }
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
    card.append(head, description);
    if (signals) card.append(signals);
    card.append(links);
    return card;
  }));
  const generated = state.sourceGeneratedAt
    ? `上次載入：${formatDate(state.sourceGeneratedAt)}${state.sourceStatus?.cache === "refreshed" ? " · 已向 GitHub 重新讀取" : ""}`
    : "";
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
      oauth_ready: "可連結帳號",
      reference_only: "僅供參考",
      self_hosting_required: "需要自建環境",
    };
    status.textContent = safeText(provider.statusLabel, labels[provider.status] || safeText(provider.status, "需要設定"));
    head.append(left, status);
    card.append(head);
    if (provider.accountLink) {
      const accountLink = document.createElement("small");
      accountLink.className = "provider-account";
      accountLink.textContent = safeText(provider.accountLink);
      card.append(accountLink);
    }
    if (provider.id === "gemini" && provider.oauth?.enabled) {
      const google = state.settings.googleAccount;
      const detail = document.createElement("small");
      detail.className = "provider-account";
      detail.textContent = google?.email
        ? `這個瀏覽器已連結：${google.name ? `${google.name} · ` : ""}${google.email}`
        : "可連結 Google，並在你同意後唯讀瀏覽 Drive 文件或 Gmail 郵件。";
      const action = document.createElement("button");
      action.type = "button";
      action.className = "provider-action";
      action.textContent = google?.email ? "中斷 Google 連結" : "連結 Google 帳號";
      action.addEventListener("click", () => {
        if (state.settings.googleAccount?.email) {
          if (googleAccessToken && window.google?.accounts?.oauth2) {
            window.google.accounts.oauth2.revoke(googleAccessToken, () => {});
          }
          googleAccessToken = null;
          googleAccessExpiresAt = 0;
          googleContentItems = [];
          delete state.settings.googleAccount;
          persist();
          render();
          showNotice("已中斷 Google 連結並清除目前頁面的存取權杖。");
          return;
        }
        connectGoogle(provider.oauth);
      });
      card.append(detail, action);
      if (google?.email) {
        const tools = document.createElement("div");
        tools.className = "provider-tools";
        for (const [kind, label] of [["drive", "讀取 Drive 文件"], ["gmail", "讀取 Gmail 郵件"]]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "provider-action";
          button.textContent = label;
          button.addEventListener("click", () => loadGoogleContent(provider.oauth, kind));
          tools.append(button);
        }
        card.append(tools);
        if (googleContentItems.length) {
          const items = document.createElement("div");
          items.className = "provider-content-list";
          for (const item of googleContentItems) {
            const row = document.createElement("div");
            row.className = "provider-content-item";
            const title = document.createElement("span");
            title.textContent = `${item.source} · ${item.title}`;
            const add = document.createElement("button");
            add.type = "button";
            add.textContent = "加入訊息";
            add.addEventListener("click", () => {
              const prompt = $("prompt");
              const current = prompt.value.trim();
              const header = `<${item.source} 標題=\"${item.title}\">\n`;
              const footer = `\n</${item.source}>`;
              const available = Math.max(0, 11800 - current.length - header.length - footer.length);
              if (available < 100) {
                showNotice("訊息草稿已接近長度上限，請先傳送或清除部分內容，再加入 Google 內容。");
                return;
              }
              prompt.value = `${current}${current ? "\n\n" : ""}${header}${item.content.slice(0, Math.min(10000, available))}${footer}`;
              prompt.focus();
              showNotice("已放入訊息草稿；檢查內容後再按傳送。只有按傳送後才會交給 Mini Codex。");
            });
            row.append(title, add);
            items.append(row);
          }
          card.append(items);
        }
      }
    }
    return card;
  }));
  if (!state.providers.length) {
    const item = document.createElement("p");
    item.className = "status-copy";
    item.textContent = "服務狀態暫時不可用。公開網站不會要求 API 金鑰。";
    list.append(item);
  }
}

let googleIdentityPromise;

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityPromise) return googleIdentityPromise;
  googleIdentityPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => window.google?.accounts?.oauth2 ? resolve() : reject(new Error("Google 帳號服務沒有完成載入。"));
    script.onerror = () => reject(new Error("無法載入 Google 帳號服務，請確認網路與瀏覽器沒有封鎖它。"));
    document.head.append(script);
  });
  return googleIdentityPromise;
}

async function requestGoogleToken(oauth, scope) {
  await loadGoogleIdentity();
  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: oauth.clientId,
      scope,
      include_granted_scopes: true,
      callback: (tokenResponse) => {
        if (tokenResponse?.error || !tokenResponse?.access_token) {
          reject(new Error(tokenResponse?.error_description || "Google 帳號授權沒有完成。"));
          return;
        }
        googleAccessToken = tokenResponse.access_token;
        googleAccessExpiresAt = Date.now() + Math.max(60, Number(tokenResponse.expires_in || 3600) - 60) * 1000;
        resolve(tokenResponse);
      },
    });
    tokenClient.requestAccessToken({ prompt: googleAccessToken ? "" : "consent" });
  });
}

async function connectGoogle(oauth) {
  if (!oauth?.enabled || !oauth.clientId) {
    showNotice("Google OAuth 尚未在這個部署平台設定。請先設定 GOOGLE_CLIENT_ID。 ");
    return;
  }
  try {
    await requestGoogleToken(oauth, "openid email profile");
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${googleAccessToken}` },
    });
    if (!response.ok) throw new Error("Google 未回傳帳號資訊。");
    const profile = await response.json();
    if (!profile?.email) throw new Error("Google 帳號資訊缺少電子郵件。 ");
    state.settings.googleAccount = {
      email: safeText(profile.email),
      name: safeText(profile.name),
      connectedAt: new Date().toISOString(),
    };
    persist();
    render();
    showNotice("Google 帳號已連結。唯讀資料只在你選取並按「加入訊息」後才會放入草稿。 ");
  } catch (error) {
    showNotice(error.message || "Google OAuth 尚未完成。 ");
  }
}

function decodeBase64Url(value) {
  const binary = atob(String(value || "").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function googleApi(path) {
  if (!googleAccessToken || Date.now() >= googleAccessExpiresAt) throw new Error("Google 授權已到期，請重新連結帳號。");
  return fetch(path, { headers: { authorization: `Bearer ${googleAccessToken}` } }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || "Google 資料讀取失敗。");
    return payload;
  });
}

async function readGmailMessage(idValue) {
  const message = await googleApi(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(idValue)}?format=full`);
  const headers = message.payload?.headers || [];
  const subject = headers.find((header) => header.name?.toLowerCase() === "subject")?.value || "Gmail 郵件";
  const parts = [];
  const walk = (part) => {
    if (part?.mimeType === "text/plain" && part.body?.data) parts.push(decodeBase64Url(part.body.data));
    for (const child of part?.parts || []) walk(child);
  };
  walk(message.payload);
  const text = parts.join("\n").trim() || message.snippet || "（沒有可讀取的純文字內容）";
  return { id: idValue, source: "Gmail", title: subject.slice(0, 180), content: text.slice(0, 24000) };
}

async function loadGoogleContent(oauth, kind) {
  if (!oauth?.enabled || !oauth.clientId) {
    showNotice("此部署尚未設定 Google OAuth Client ID。");
    return;
  }
  try {
    const scope = kind === "drive"
      ? "https://www.googleapis.com/auth/drive.readonly"
      : "https://www.googleapis.com/auth/gmail.readonly";
    await requestGoogleToken(oauth, scope);
    const items = [];
    if (kind === "drive") {
      const query = new URLSearchParams({
        q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
        orderBy: "modifiedTime desc",
        pageSize: "15",
        fields: "files(id,name,mimeType,modifiedTime)",
      });
      const result = await googleApi(`https://www.googleapis.com/drive/v3/files?${query}`);
      for (const file of result.files || []) {
        const mime = file.mimeType || "";
        const exportType = mime === "application/vnd.google-apps.document" || mime === "application/vnd.google-apps.presentation"
          ? "text/plain"
          : mime === "application/vnd.google-apps.spreadsheet" ? "text/csv" : "";
        if (!exportType) continue;
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportType)}`, {
          headers: { authorization: `Bearer ${googleAccessToken}` },
        });
        if (!response.ok) continue;
        items.push({ id: file.id, source: "Google Drive", title: file.name || "未命名文件", content: (await response.text()).slice(0, 24000) });
      }
    } else {
      const result = await googleApi("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=newer_than%3A30d");
      items.push(...await Promise.all((result.messages || []).slice(0, 10).map((message) => readGmailMessage(message.id))));
    }
    googleContentItems = items;
    renderProviders();
    showNotice(items.length ? `已列出 ${items.length} 個唯讀項目；只有按「加入訊息」才會放入草稿。` : "Google 沒有找到可匯入的文字文件或郵件。");
  } catch (error) {
    showNotice(error.message || "讀取 Google 內容失敗。");
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

async function refreshCloudData({ forceSources = false } = {}) {
  const sourceQuery = forceSources ? `?refresh=1&_=${Date.now()}` : `?_=${Date.now()}`;
  const results = await Promise.allSettled([
    request(`/api/state?_=${Date.now()}`),
    request(`/api/sources${sourceQuery}`),
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
    state.sourceStatus = sources.value;
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
  $("refresh-sources").addEventListener("click", async () => {
    const button = $("refresh-sources");
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "正在重新檢查…";
    try {
      await refreshCloudData({ forceSources: true });
      showNotice("已向 GitHub 重新檢查受信任來源。AI 程式碼審查請在本機 Mini 進行。");
    } catch (error) {
      showNotice(error.message || "來源更新暫時無法完成。");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
  $("hide-mini").addEventListener("click", () => { state.settings.miniHidden = true; persist(); render(); });
  $("install-app").addEventListener("click", () => {
    const dialog = $("install-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  });
  const nativeInstallButton = $("install-pwa-now");
  if (nativeInstallButton) {
    nativeInstallButton.hidden = !installPrompt;
    nativeInstallButton.addEventListener("click", async () => {
      const promptEvent = installPrompt;
      if (!promptEvent) return;
      installPrompt = null;
      nativeInstallButton.hidden = true;
      $("install-dialog").close();
      promptEvent.prompt();
      await promptEvent.userChoice;
      $("install-app").textContent = "安裝說明";
    });
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    if (nativeInstallButton) nativeInstallButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    if (nativeInstallButton) nativeInstallButton.hidden = true;
    $("install-app").textContent = "已安裝";
  });
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
