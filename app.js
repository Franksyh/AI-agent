const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const storageKey = "future-assistant-ui";

const state = {
  mode: "confirm",
  backendOnline: false,
  backendInfo: null,
  currentPlan: [],
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

const workflows = [
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
    icon: "calendar-check",
    title: "行程與提醒",
    text: "整理日程、找出衝突、安排優先順序、建立提醒清單。",
    goal: "整理本週行程，找出衝突並建立提醒清單",
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
  $("#safetyMetric").textContent = title.replace("模式", "");
}

function routeTo(route) {
  $$(".rail-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.route === route);
  });
  $$(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === route);
  });
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

async function checkBackend() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1400);
  try {
    const response = await fetch("/api/state", { signal: controller.signal });
    if (!response.ok) throw new Error("backend unavailable");
    state.backendInfo = await response.json();
    state.backendOnline = true;
  } catch {
    state.backendOnline = false;
    state.backendInfo = null;
  } finally {
    clearTimeout(timer);
    renderConnection();
    renderSystemInfo();
  }
}

function renderConnection() {
  const dot = $("#connectionDot");
  dot.classList.toggle("online", state.backendOnline);
  dot.classList.toggle("offline", !state.backendOnline);
  $("#connectionStatus").textContent = state.backendOnline ? "本機 Agent 已連線" : "Netlify 展示模式";
}

function renderSystemInfo() {
  const data = {
    模式: state.backendOnline ? "本機後端" : "靜態網站",
    瀏覽器: navigator.userAgent,
    語音輸入: window.SpeechRecognition || window.webkitSpeechRecognition ? "可用" : "未支援",
    儲存: "localStorage",
    GitHub: "Franksyh/AI-agent",
    Netlify: "franksyh-ai-agent.netlify.app",
  };

  if (state.backendInfo) {
    data.Python = state.backendInfo.python || "已連線";
    data.工作區 = state.backendInfo.workspace || "本機";
  }

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

async function handleChat(event) {
  event.preventDefault();
  const input = $("#promptInput");
  const message = input.value.trim();
  if (!message) return;

  input.value = "";
  addMessage("user", message);

  if (state.backendOnline) {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "本機 Agent 回應失敗");
      addMessage("system", data.reply || buildLocalReply(message));
      if (data.suggestions?.length) {
        const goal = data.suggestions.map((item) => item.title || item.action).join("，");
        setPlan(createPlan(goal));
      }
      return;
    } catch {
      state.backendOnline = false;
      renderConnection();
    }
  }

  const reply = buildLocalReply(message);
  addMessage("system", reply);
  setPlan(createPlan(message));
}

function buildLocalReply(message) {
  const lower = message.toLowerCase();
  if (lower.includes("github") || lower.includes("netlify") || message.includes("部署") || message.includes("同步")) {
    return "我會把流程拆成四段：檢查檔案、提交 GitHub、部署 Netlify、驗證公開網址。這個展示站會先產生清楚的執行清單。";
  }
  if (message.includes("文件") || message.includes("摘要") || message.includes("PDF")) {
    return "可以先上傳文字或 Markdown 檔，我會摘要重點、抓出待辦，並把結果轉成可交付的結構。";
  }
  if (message.includes("搜尋") || message.includes("研究") || message.includes("比較")) {
    return "我會先定義研究問題，再整理來源、比較條件與輸出格式，避免只得到零散連結。";
  }
  if (message.includes("客服") || message.includes("信件")) {
    return "我會辨識情緒、需求、期限與下一步，先產生回覆草稿，再建立待辦。";
  }
  return "我已經把你的目標轉成可執行計畫。你可以到任務規劃檢查步驟，也可以複製成 Markdown 繼續使用。";
}

function createPlan(goal) {
  const text = goal.trim() || "建立一個可發布的 AI Agent 工作流程";
  const lower = text.toLowerCase();
  const deploy = lower.includes("github") || lower.includes("netlify") || text.includes("部署") || text.includes("同步");
  const research = text.includes("研究") || text.includes("搜尋") || text.includes("比較");
  const documentTask = text.includes("文件") || text.includes("摘要") || text.includes("簡報");

  if (deploy) {
    return [
      { phase: "檢查", steps: ["確認工作區狀態", "檢查首頁與靜態資源", "排除不應上傳的本機檔案"] },
      { phase: "提交", steps: ["建立清楚的 commit", "推送到 GitHub main", "確認遠端 commit 一致"] },
      { phase: "部署", steps: ["使用既有 Netlify site", "上傳最新檔案", "等待 production deploy ready"] },
      { phase: "驗證", steps: ["開啟公開網址", "檢查 HTTP 200", "回傳 GitHub 與 Netlify 連結"] },
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

function setPlan(plan) {
  state.currentPlan = plan;
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
  const markdown = planMarkdown();
  await navigator.clipboard.writeText(markdown);
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

function renderWorkflows() {
  const grid = $("#workflowGrid");
  grid.innerHTML = "";
  workflows.forEach((workflow) => {
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
    card.querySelector("button").addEventListener("click", () => {
      $("#goalInput").value = workflow.goal;
      setPlan(createPlan(workflow.goal));
      addMessage("system", `已建立「${workflow.title}」的流程計畫。`);
    });
    grid.appendChild(card);
  });
  refreshIcons();
}

function handleQuickAction(intent) {
  const map = {
    "github-netlify": "將目前資料夾同步至 GitHub 並部署到 Netlify，完成後回傳公開連結",
    research: "整理 AI Agent 產品趨勢，產生比較表與重點摘要",
    document: "摘要一份產品介紹文件，整理成簡報大綱",
    support: "收到客戶詢問後，自動產生禮貌回覆與待辦事項",
  };
  const goal = map[intent] || "規劃一個 AI Agent 工作流程";
  $("#goalInput").value = goal;
  setPlan(createPlan(goal));
  addMessage("system", `已建立快速任務：${goal}`);
}

async function summarizeFile(file) {
  const summary = $("#fileSummary");
  if (!file) {
    summary.textContent = "尚未選擇檔案。";
    return;
  }

  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const preview = lines.slice(0, 8).join("\n");

  summary.textContent = [
    `檔名：${file.name}`,
    `大小：${formatBytes(file.size)}`,
    `行數：${lines.length}`,
    `詞數：約 ${words}`,
    "",
    "前段預覽：",
    preview || "沒有可讀文字內容。",
  ].join("\n");
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
    const text = event.results[0][0].transcript;
    $("#promptInput").value = text;
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
  $("#buildPlan").addEventListener("click", () => setPlan(createPlan($("#goalInput").value)));
  $("#copyPlan").addEventListener("click", copyPlan);
  $("#downloadPlan").addEventListener("click", downloadPlan);
  $("#fileInput").addEventListener("change", (event) => summarizeFile(event.target.files[0]));
  $("#openSearch").addEventListener("click", openSearch);

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

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  applySettings();
  setupEvents();
  setupVoiceInput();
  renderWorkflows();
  setPlan(createPlan("將目前資料夾同步至 GitHub 並部署到 Netlify，完成後回傳公開連結"));
  routeTo("overview");
  refreshClock();
  setInterval(refreshClock, 1000);
  checkBackend();
  addMessage("system", "歡迎使用 Future Assistant。輸入一個目標，我會把它拆成可執行的工作流程。");
  refreshIcons();
});
