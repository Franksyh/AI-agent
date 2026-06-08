const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  suggestions: [],
  voice: {
    recognition: null,
    mediaRecorder: null,
    chunks: [],
    recording: false,
    stopTimer: null,
  },
  settings: {
    apiBase: "https://api.openai.com/v1",
    apiModel: "",
    sttModel: "whisper-1",
    apiKey: "",
    voiceReplies: true,
    largeText: false,
    highContrast: false,
    reducedMotion: false,
  },
};

function loadSettings() {
  const saved = localStorage.getItem("future-assistant-settings");
  if (saved) {
    Object.assign(state.settings, JSON.parse(saved));
  }
  $("#apiBase").value = state.settings.apiBase;
  $("#apiModel").value = state.settings.apiModel;
  $("#sttModel").value = state.settings.sttModel;
  $("#apiKey").value = state.settings.apiKey;
  $("#voiceReplies").checked = state.settings.voiceReplies;
  $("#largeText").checked = state.settings.largeText;
  $("#highContrast").checked = state.settings.highContrast;
  $("#reducedMotion").checked = state.settings.reducedMotion;
  applyAccessibility();
}

function saveSettings() {
  state.settings.apiBase = $("#apiBase").value.trim();
  state.settings.apiModel = $("#apiModel").value.trim();
  state.settings.sttModel = $("#sttModel").value.trim() || "whisper-1";
  state.settings.apiKey = $("#apiKey").value.trim();
  state.settings.voiceReplies = $("#voiceReplies").checked;
  state.settings.largeText = $("#largeText").checked;
  state.settings.highContrast = $("#highContrast").checked;
  state.settings.reducedMotion = $("#reducedMotion").checked;
  localStorage.setItem("future-assistant-settings", JSON.stringify(state.settings));
  applyAccessibility();
  addMessage("system", "設定已儲存。");
}

function applyAccessibility() {
  document.body.classList.toggle("large-text", state.settings.largeText);
  document.body.classList.toggle("high-contrast", state.settings.highContrast);
  document.body.classList.toggle("reduced-motion", state.settings.reducedMotion);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || "操作失敗");
  }
  return data;
}

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  $("#messages").appendChild(node);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  if (role !== "user" && state.settings.voiceReplies) {
    speak(text);
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-TW";
  utterance.rate = 1;
  speechSynthesis.speak(utterance);
}

function renderSuggestions(suggestions) {
  state.suggestions = suggestions;
  const wrap = $("#suggestions");
  wrap.innerHTML = "";
  if (!suggestions.length) {
    wrap.innerHTML = `<div class="result-item"><small>沒有待執行動作。</small></div>`;
    return;
  }
  suggestions.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = `suggestion risk-${item.risk || "low"}`;
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.action)} · ${escapeHtml(JSON.stringify(item.payload))}</small>
      </span>
      <i data-lucide="chevron-right"></i>
    `;
    button.addEventListener("click", () => runSuggested(index));
    wrap.appendChild(button);
  });
  refreshIcons();
}

async function runSuggested(index) {
  const item = state.suggestions[index];
  if (!item) return;
  const mode = $("input[name='autonomy']:checked").value;
  const needsConfirm = mode !== "execute" || item.risk === "high" || item.action === "run_command";
  if (needsConfirm) {
    const ok = await confirmAction(`${item.title}\n${JSON.stringify(item.payload, null, 2)}`);
    if (!ok) return;
  }
  await executeAction(item.action, item.payload);
}

async function executeAction(action, payload = {}) {
  try {
    if (action === "run_command") {
      payload.confirmed = true;
      payload.safety = $("#strictSafety").checked ? "strict" : "advanced";
    }
    const data = await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action, payload }),
    });
    presentActionResult(action, data);
  } catch (error) {
    addMessage("system", `操作沒有完成：${error.message}`);
  }
}

function presentActionResult(action, data) {
  if (action === "web_search") {
    renderWebResults(data);
    switchView("search");
    addMessage("system", data.results.length ? `找到 ${data.results.length} 筆搜尋結果。` : "已建立搜尋連結，可以直接開啟瀏覽器查看。");
    return;
  }
  if (action === "file_search") {
    renderFileResults(data);
    switchView("search");
    addMessage("system", `找到 ${data.results.length} 個檔案。`);
    return;
  }
  if (action === "screenshot" && data.url) {
    $("#previewPane").innerHTML = `<img src="${data.url}" alt="螢幕截圖" />`;
    switchView("access");
    addMessage("system", "截圖完成，已放在預覽區。");
    return;
  }
  if (action === "get_clipboard") {
    $("#readText").value = data.text || "";
    switchView("access");
    addMessage("system", data.text ? "剪貼簿內容已載入。" : "剪貼簿目前沒有文字。");
    return;
  }
  if (action === "run_command") {
    $("#commandOutput").textContent = formatCommandResult(data);
    switchView("computer");
    addMessage("system", data.ok ? "命令執行完成。" : "命令已停止或被阻擋。");
    return;
  }
  addMessage("system", data.message || "操作完成。");
}

function formatCommandResult(data) {
  const parts = [
    `ok: ${data.ok}`,
    data.exitCode !== undefined ? `exitCode: ${data.exitCode}` : "",
    data.blocked ? `blocked: ${data.blocked}` : "",
    data.message ? `message: ${data.message}` : "",
    data.stdout ? `\n[stdout]\n${data.stdout}` : "",
    data.stderr ? `\n[stderr]\n${data.stderr}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

async function handleChat(event) {
  event.preventDefault();
  const input = $("#promptInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  addMessage("user", message);

  try {
    let replyData;
    if (state.settings.apiKey && state.settings.apiModel) {
      replyData = await askModel(message);
      addMessage("system", replyData.reply || "模型沒有回覆文字。");
      const local = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      renderSuggestions(local.suggestions || []);
    } else {
      replyData = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      addMessage("system", replyData.reply);
      renderSuggestions(replyData.suggestions || []);
    }
  } catch (error) {
    addMessage("system", `我暫時無法完成：${error.message}`);
  }
}

async function askModel(message) {
  const system = [
    "你是 Future Assistant 的中文電腦操作助手。",
    "請簡潔回答，並提醒高風險電腦操作需要使用者確認。",
    "你可以建議搜尋、命令、檔案搜尋、截圖、滑鼠鍵盤操作，但不要假裝已經執行。",
  ].join("\n");
  return api("/api/model", {
    method: "POST",
    body: JSON.stringify({
      apiBase: state.settings.apiBase,
      apiKey: state.settings.apiKey,
      model: state.settings.apiModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message },
      ],
    }),
  });
}

function renderWebResults(data) {
  const wrap = $("#webResults");
  wrap.innerHTML = "";
  if (data.warning) {
    wrap.appendChild(resultNode("搜尋服務訊息", data.warning, data.searchUrl));
  }
  if (!data.results.length) {
    wrap.appendChild(resultNode("開啟搜尋頁", data.searchUrl, data.searchUrl));
    return;
  }
  data.results.forEach((item) => wrap.appendChild(resultNode(item.title, item.url, item.url)));
}

function renderFileResults(data) {
  const wrap = $("#fileResults");
  wrap.innerHTML = "";
  if (!data.results.length) {
    wrap.innerHTML = `<div class="result-item"><small>沒有找到符合的檔案。</small></div>`;
    return;
  }
  data.results.forEach((item) => {
    const node = document.createElement("div");
    node.className = "result-item";
    node.innerHTML = `
      <strong>${escapeHtml(item.name)}</strong>
      <small>${escapeHtml(item.path)}</small>
      <small>${formatBytes(item.size)}</small>
    `;
    wrap.appendChild(node);
  });
}

function resultNode(title, detail, url) {
  const node = document.createElement("div");
  node.className = "result-item";
  node.innerHTML = `
    <a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>
    <small>${escapeHtml(detail)}</small>
  `;
  return node;
}

function confirmAction(text) {
  const dialog = $("#confirmDialog");
  $("#confirmText").textContent = text;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

function switchView(view) {
  $$(".side-rail .icon-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $$("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $("#micButton");
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  if (SpeechRecognition) {
    state.voice.recognition = new SpeechRecognition();
    state.voice.recognition.lang = "zh-TW";
    state.voice.recognition.interimResults = false;
    state.voice.recognition.continuous = false;
    state.voice.recognition.addEventListener("result", (event) => {
      const text = event.results[0][0].transcript;
      acceptVoiceText(text);
    });
    state.voice.recognition.addEventListener("error", async (event) => {
      button.classList.remove("active");
      setVoiceStatus(`瀏覽器語音辨識失敗：${event.error}`);
      if (event.error === "network" || event.error === "not-allowed" || event.error === "service-not-allowed") {
        await startVoiceFallback();
      }
    });
    state.voice.recognition.addEventListener("end", () => {
      button.classList.remove("active");
    });
    setVoiceStatus("語音輸入待命：使用瀏覽器語音辨識");
  } else if (canRecord) {
    setVoiceStatus("語音輸入待命：此瀏覽器不支援即時辨識，會使用錄音轉文字或 Windows 語音輸入");
  } else {
    setVoiceStatus("語音輸入待命：將嘗試啟動 Windows 語音輸入");
  }

  button.addEventListener("click", async () => {
    if (state.voice.recording) {
      stopVoiceRecording();
      return;
    }
    if (state.voice.recognition) {
      try {
        button.classList.add("active");
        setVoiceStatus("正在聆聽，請開始說話");
        state.voice.recognition.start();
      } catch (error) {
        button.classList.remove("active");
        setVoiceStatus(`語音啟動失敗：${error.message}`);
        await startVoiceFallback();
      }
      return;
    }
    await startVoiceFallback();
  });
}

async function startVoiceFallback() {
  if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder && state.settings.apiKey) {
    await startVoiceRecording();
    return;
  }
  await startWindowsVoiceTyping();
}

async function startVoiceRecording() {
  const button = $("#micButton");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = preferredAudioMimeType();
    const options = mimeType ? { mimeType } : undefined;
    state.voice.chunks = [];
    state.voice.mediaRecorder = new MediaRecorder(stream, options);
    state.voice.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) state.voice.chunks.push(event.data);
    });
    state.voice.mediaRecorder.addEventListener("stop", async () => {
      clearTimeout(state.voice.stopTimer);
      stream.getTracks().forEach((track) => track.stop());
      state.voice.recording = false;
      button.classList.remove("active");
      const blob = new Blob(state.voice.chunks, { type: state.voice.mediaRecorder.mimeType || "audio/webm" });
      await transcribeBlob(blob);
    });
    state.voice.mediaRecorder.start();
    state.voice.recording = true;
    button.classList.add("active");
    setVoiceStatus("正在錄音，按一次麥克風結束；最多 20 秒");
    state.voice.stopTimer = setTimeout(stopVoiceRecording, 20000);
  } catch (error) {
    button.classList.remove("active");
    setVoiceStatus(`錄音失敗：${error.message}`);
    await startWindowsVoiceTyping();
  }
}

function stopVoiceRecording() {
  if (state.voice.mediaRecorder && state.voice.mediaRecorder.state !== "inactive") {
    setVoiceStatus("正在轉成文字");
    state.voice.mediaRecorder.stop();
  }
}

async function transcribeBlob(blob) {
  try {
    const audioBase64 = await blobToBase64(blob);
    const data = await api("/api/transcribe", {
      method: "POST",
      body: JSON.stringify({
        apiBase: state.settings.apiBase,
        apiKey: state.settings.apiKey,
        model: state.settings.sttModel || "whisper-1",
        mimeType: blob.type || "audio/webm",
        audioBase64,
        language: "zh",
      }),
    });
    if (!data.text) {
      setVoiceStatus("沒有辨識到文字，請再試一次");
      return;
    }
    acceptVoiceText(data.text);
  } catch (error) {
    setVoiceStatus(`語音轉文字失敗：${error.message}`);
  }
}

async function startWindowsVoiceTyping() {
  $("#promptInput").focus();
  setVoiceStatus("正在啟動 Windows 語音輸入；如果跳出語音列，請直接開始說話");
  try {
    await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "hotkey", payload: { keys: "win+h" } }),
    });
  } catch (error) {
    setVoiceStatus(`無法啟動 Windows 語音輸入：${error.message}`);
  }
}

function acceptVoiceText(text) {
  const value = text.trim();
  if (!value) {
    setVoiceStatus("沒有辨識到文字，請再試一次");
    return;
  }
  $("#promptInput").value = value;
  setVoiceStatus(`已辨識：${value}`);
  $("#chatForm").requestSubmit();
}

function preferredAudioMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/wav"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取錄音失敗"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}

function setVoiceStatus(message) {
  const status = $("#voiceStatus");
  if (status) status.textContent = message;
}

function setupEvents() {
  $$(".side-rail .icon-button").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  $("#chatForm").addEventListener("submit", handleChat);
  $("#clearActions").addEventListener("click", () => renderSuggestions([]));
  $("#saveSettings").addEventListener("click", saveSettings);

  ["voiceReplies", "largeText", "highContrast", "reducedMotion"].forEach((id) => {
    $(`#${id}`).addEventListener("change", saveSettings);
  });

  $("#moveMouse").addEventListener("click", () => executeAction("move", { x: $("#mouseX").value, y: $("#mouseY").value }));
  $("#leftClick").addEventListener("click", () => executeAction("click", { button: "left" }));
  $("#typeButton").addEventListener("click", () => executeAction("type", { text: $("#typeText").value }));
  $$(".hotkeys button").forEach((button) => {
    button.addEventListener("click", () => executeAction("hotkey", { keys: button.dataset.hotkey }));
  });

  $("#previewCommand").addEventListener("click", async () => {
    const command = $("#commandInput").value.trim();
    const data = await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "run_command", payload: { command, confirmed: false } }),
    });
    $("#commandOutput").textContent = JSON.stringify(data, null, 2);
  });
  $("#runCommand").addEventListener("click", async () => {
    const command = $("#commandInput").value.trim();
    if (!command) return;
    const ok = await confirmAction(`確認執行命令？\n${command}`);
    if (!ok) return;
    executeAction("run_command", { command });
  });

  $("#webSearchButton").addEventListener("click", () => executeAction("web_search", { query: $("#webQuery").value }));
  $("#fileSearchButton").addEventListener("click", () => executeAction("file_search", { query: $("#fileQuery").value }));
  $("#readAloud").addEventListener("click", () => speak($("#readText").value));

  $$("[data-quick]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.quick;
      if (kind === "screenshot") executeAction("screenshot", {});
      if (kind === "clipboard") executeAction("get_clipboard", {});
      if (kind === "date") {
        $("#commandInput").value = "Get-Date";
        switchView("computer");
      }
      if (kind === "search") switchView("search");
    });
  });

  $$("[data-workflow]").forEach((button) => {
    button.addEventListener("click", async () => {
      const flow = button.dataset.workflow;
      if (flow === "readClipboard") {
        const data = await api("/api/action", { method: "POST", body: JSON.stringify({ action: "get_clipboard", payload: {} }) });
        $("#readText").value = data.text || "";
        speak(data.text || "剪貼簿目前沒有文字。");
      }
      if (flow === "captureAndReview") executeAction("screenshot", {});
      if (flow === "focusMode") {
        state.settings.reducedMotion = true;
        state.settings.largeText = true;
        state.settings.voiceReplies = false;
        $("#reducedMotion").checked = true;
        $("#largeText").checked = true;
        $("#voiceReplies").checked = false;
        saveSettings();
      }
    });
  });
}

async function loadState() {
  try {
    const data = await api("/api/state");
    $("#connectionDot").classList.add("online");
    $("#statusText").textContent = "已連線";
    const info = $("#systemInfo");
    info.innerHTML = "";
    Object.entries({
      版本: data.version,
      主機: data.host,
      平台: data.platform,
      Python: data.python,
      工作區: data.workspace,
      電腦控制: data.capabilities.computerControl ? "可用" : "不可用",
    }).forEach(([key, value]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = key;
      dd.textContent = value;
      info.append(dt, dd);
    });
  } catch (error) {
    $("#statusText").textContent = "未連線";
  }
}

function refreshClock() {
  $("#systemClock").textContent = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
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

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(size || 0);
  let unit = 0;
  while (value > 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  setupEvents();
  setupVoice();
  loadState();
  refreshClock();
  setInterval(refreshClock, 1000);
  addMessage("system", "我已就緒。你可以用文字或語音下指令，所有高風險操作都會先確認。");
  renderSuggestions([]);
  refreshIcons();
});
