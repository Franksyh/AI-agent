import { getDeployStore, getStore } from "@netlify/blobs";

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "") || "state";

  try {
    if (req.method === "GET" && route === "state") {
      return jsonResponse(createState(context));
    }

    if (req.method === "GET" && route === "workflows") {
      return jsonResponse({
        ok: true,
        generatedAt: new Date().toISOString(),
        workflows: workflowTemplates(),
      });
    }

    if (req.method === "POST" && route === "chat") {
      const body = await readJson(req);
      const message = cleanText(body.message);
      const mode = cleanText(body.mode || "confirm");
      const plan = createPlan(message);

      return jsonResponse({
        ok: true,
        dynamic: true,
        intent: detectIntent(message),
        mode,
        reply: createReply(message, plan, mode),
        plan,
        requestId: getRequestId(context),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && route === "plan") {
      const body = await readJson(req);
      const goal = cleanText(body.goal);
      const plan = createPlan(goal);

      return jsonResponse({
        ok: true,
        dynamic: true,
        goal,
        plan,
        markdown: planToMarkdown(plan),
        requestId: getRequestId(context),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && route === "brief") {
      const body = await readJson(req);
      const text = cleanText(body.text);
      const name = cleanText(body.name || "未命名檔案");

      return jsonResponse({
        ok: true,
        dynamic: true,
        name,
        brief: createBrief(text),
        requestId: getRequestId(context),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && route === "remote") {
      const body = await readJson(req);
      const result = await handleRemote(body, url, context);
      return jsonResponse(result);
    }

    return jsonResponse({ ok: false, error: `Unknown API route: ${route}` }, { status: 404 });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "API 發生未預期錯誤",
      },
      { status: 500 },
    );
  }
};

export const config = {
  path: "/api/*",
};

async function readJson(req) {
  if (!req.body) return {};
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function createState(context) {
  return {
    ok: true,
    dynamic: true,
    app: "Future Assistant",
    runtime: "Netlify Functions + Blobs",
    apiVersion: "2026-06-09.remote.1",
    requestId: getRequestId(context),
    serverTime: new Date().toISOString(),
    capabilities: {
      serverPlanning: true,
      dynamicChat: true,
      fileBriefing: true,
      workflowTemplates: true,
      remoteSessions: true,
      mobileRemote: true,
      desktopRemote: true,
      webRemote: true,
      staticFallback: true,
    },
  };
}

function getRequestId(context) {
  return context?.requestId || context?.server?.requestId || crypto.randomUUID();
}

function cleanText(value, limit = 20000) {
  return String(value || "").trim().slice(0, limit);
}

function getRemoteStore() {
  const deployContext = globalThis.Netlify?.context?.deploy?.context;
  if (deployContext === "production") {
    return getStore("future-assistant-remote", { consistency: "strong" });
  }
  return getDeployStore("future-assistant-remote");
}

async function handleRemote(body, url, context) {
  const action = cleanText(body.action, 32);
  if (action === "create") return createRemoteSession(body, url, context);
  if (action === "join") return joinRemoteSession(body, context);
  if (action === "heartbeat") return heartbeatRemoteSession(body, context);
  if (action === "poll") return pollRemoteSession(body, context);
  if (action === "send") return sendRemoteCommand(body, context);
  if (action === "close") return closeRemoteSession(body, context);
  throw new Error("未知的遠端連線操作");
}

async function createRemoteSession(body, url, context) {
  const store = getRemoteStore();
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const code = await createUniqueCode(store);
  const device = createDevice(body, "host");
  const session = {
    id: sessionId,
    code,
    status: "waiting",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString(),
    sequence: 1,
    devices: [device],
    events: [
      {
        id: crypto.randomUUID(),
        sequence: 1,
        type: "system",
        commandType: "session_created",
        fromDeviceId: device.id,
        fromName: device.name,
        message: `${device.name} 建立了遠端 session`,
        payload: {},
        createdAt: now,
      },
    ],
  };

  await saveSession(store, session);
  await store.setJSON(codeKey(code), { sessionId, code });

  return {
    ok: true,
    dynamic: true,
    role: "host",
    deviceId: device.id,
    token: device.token,
    cursor: session.sequence,
    joinUrl: `${url.origin}/?session=${encodeURIComponent(code)}`,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: now,
  };
}

async function joinRemoteSession(body, context) {
  const store = getRemoteStore();
  const code = cleanText(body.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) throw new Error("請提供配對碼");

  const mapping = await store.get(codeKey(code), { type: "json" });
  if (!mapping?.sessionId) throw new Error("找不到這組配對碼");

  const session = await loadSession(store, mapping.sessionId);
  assertSessionOpen(session);

  const device = createDevice(body, "guest");
  session.devices = upsertDevice(session.devices, device);
  session.status = "active";
  appendEvent(session, {
    type: "system",
    commandType: "device_joined",
    fromDeviceId: device.id,
    fromName: device.name,
    message: `${device.name} 已加入遠端 session`,
    payload: { deviceType: device.type },
  });
  await saveSession(store, session);

  return {
    ok: true,
    dynamic: true,
    role: "guest",
    deviceId: device.id,
    token: device.token,
    cursor: session.sequence,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: new Date().toISOString(),
  };
}

async function heartbeatRemoteSession(body, context) {
  const { store, session, device } = await authorizedSession(body);
  device.lastSeen = new Date().toISOString();
  device.name = cleanText(body.deviceName, 80) || device.name;
  device.type = cleanText(body.deviceType, 20) || device.type;
  session.updatedAt = device.lastSeen;
  session.devices = upsertDevice(session.devices, device);
  await saveSession(store, session);

  return {
    ok: true,
    dynamic: true,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: device.lastSeen,
  };
}

async function pollRemoteSession(body, context) {
  const { session, device } = await authorizedSession(body);
  const cursor = Number(body.cursor || 0);
  const events = session.events
    .filter((event) => event.sequence > cursor && event.fromDeviceId !== device.id)
    .map(publicEvent);

  return {
    ok: true,
    dynamic: true,
    cursor: session.sequence,
    events,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: new Date().toISOString(),
  };
}

async function sendRemoteCommand(body, context) {
  const { store, session, device } = await authorizedSession(body);
  const commandType = cleanText(body.commandType || "text", 32);
  const payload = sanitizePayload(body.payload || {});
  const message = payload.text || commandType;

  appendEvent(session, {
    type: "command",
    commandType,
    target: cleanText(body.target || "all", 32),
    fromDeviceId: device.id,
    fromName: device.name,
    message,
    payload,
  });
  await saveSession(store, session);

  return {
    ok: true,
    dynamic: true,
    cursor: session.sequence,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: new Date().toISOString(),
  };
}

async function closeRemoteSession(body, context) {
  const { store, session, device } = await authorizedSession(body);
  session.status = "closed";
  appendEvent(session, {
    type: "system",
    commandType: "session_closed",
    fromDeviceId: device.id,
    fromName: device.name,
    message: `${device.name} 關閉了遠端 session`,
    payload: {},
  });
  await saveSession(store, session);

  return {
    ok: true,
    dynamic: true,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: new Date().toISOString(),
  };
}

async function authorizedSession(body) {
  const store = getRemoteStore();
  const sessionId = cleanText(body.sessionId, 80);
  const token = cleanText(body.token, 120);
  if (!sessionId || !token) throw new Error("缺少 session 或裝置 token");

  const session = await loadSession(store, sessionId);
  assertSessionOpen(session);

  const device = session.devices.find((item) => item.token === token);
  if (!device) throw new Error("裝置驗證失敗");
  return { store, session, device };
}

async function createUniqueCode(store) {
  for (let index = 0; index < 10; index += 1) {
    const code = randomCode();
    const existing = await store.get(codeKey(code), { type: "json" });
    if (!existing) return code;
  }
  throw new Error("暫時無法產生配對碼，請再試一次");
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function createDevice(body, role) {
  const now = new Date().toISOString();
  const type = normalizeDeviceType(body.deviceType);
  return {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    role,
    name: cleanText(body.deviceName, 80) || defaultDeviceName(type),
    type,
    joinedAt: now,
    lastSeen: now,
  };
}

function normalizeDeviceType(type) {
  const value = cleanText(type, 20);
  return ["mobile", "desktop", "web"].includes(value) ? value : "web";
}

function defaultDeviceName(type) {
  if (type === "mobile") return "手機版裝置";
  if (type === "desktop") return "電腦版裝置";
  return "網頁版裝置";
}

function upsertDevice(devices, device) {
  const next = devices.filter((item) => item.id !== device.id && item.token !== device.token);
  next.push(device);
  return next.slice(-8);
}

function appendEvent(session, event) {
  const now = new Date().toISOString();
  session.sequence += 1;
  session.updatedAt = now;
  session.events.push({
    id: crypto.randomUUID(),
    sequence: session.sequence,
    createdAt: now,
    ...event,
  });
  session.events = session.events.slice(-100);
}

function sanitizePayload(payload) {
  return {
    text: cleanText(payload.text, 2000),
    url: cleanText(payload.url, 1000),
  };
}

async function loadSession(store, sessionId) {
  const session = await store.get(sessionKey(sessionId), { type: "json" });
  if (!session) throw new Error("找不到遠端 session");
  return session;
}

async function saveSession(store, session) {
  await store.setJSON(sessionKey(session.id), session);
}

function assertSessionOpen(session) {
  if (session.status === "closed") throw new Error("這個 session 已關閉");
  if (Date.parse(session.expiresAt) < Date.now()) throw new Error("這個 session 已過期");
}

function sessionKey(sessionId) {
  return `session/${sessionId}.json`;
}

function codeKey(code) {
  return `code/${code}.json`;
}

function publicSession(session) {
  const onlineCutoff = Date.now() - 45000;
  return {
    id: session.id,
    code: session.code,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    sequence: session.sequence,
    devices: session.devices.map((device) => ({
      id: device.id,
      role: device.role,
      name: device.name,
      type: device.type,
      joinedAt: device.joinedAt,
      lastSeen: device.lastSeen,
      online: Date.parse(device.lastSeen) >= onlineCutoff,
    })),
  };
}

function publicEvent(event) {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    commandType: event.commandType,
    target: event.target,
    fromDeviceId: event.fromDeviceId,
    fromName: event.fromName,
    message: event.message,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function workflowTemplates() {
  return [
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
}

function detectIntent(message) {
  const lower = message.toLowerCase();
  if (message.includes("遠端") || message.includes("手機") || message.includes("電腦") || message.includes("網頁")) return "remote";
  if (lower.includes("github") || lower.includes("netlify") || message.includes("部署") || message.includes("同步")) return "deploy";
  if (message.includes("研究") || message.includes("搜尋") || message.includes("比較")) return "research";
  if (message.includes("文件") || message.includes("摘要") || message.includes("簡報") || lower.includes("pdf")) return "document";
  if (message.includes("客服") || message.includes("信件") || message.includes("回覆")) return "support";
  return "general";
}

function createReply(message, plan, mode) {
  const intent = detectIntent(message);
  const phaseCount = plan.length;
  const stepCount = plan.reduce((sum, item) => sum + item.steps.length, 0);
  const modeCopy = mode === "execute" ? "我會保留高風險確認點" : mode === "observe" ? "我會只提供建議與分析" : "我會先列計畫再等待確認";

  const intro = {
    remote: "我已把遠端連線拆成建立 session、跨裝置加入、同步狀態與安全控制。",
    deploy: "我已把發布任務拆成 GitHub 與 Netlify 的動態部署流程。",
    research: "我已把研究任務拆成問題定義、資料蒐集、比較整理與交付。",
    document: "我已把文件任務拆成讀取、摘要、轉換與確認。",
    support: "我已把客服任務拆成辨識需求、產生草稿、建立待辦與追蹤。",
    general: "我已把你的目標拆成可執行的工作流程。",
  }[intent];

  return `${intro}\n\n目前模式：${modeCopy}。\n這次由 Netlify Function 即時產生 ${phaseCount} 個階段、${stepCount} 個步驟。`;
}

function createPlan(goal) {
  const text = goal || "支援手機版、電腦版與網頁版遠端連線功能";
  const intent = detectIntent(text);

  if (intent === "remote") {
    return [
      { phase: "建立連線", steps: ["電腦版建立主控 session", "產生配對碼與 QR code", "保存 session token"] },
      { phase: "跨裝置加入", steps: ["手機版用配對碼加入", "網頁版用連線網址加入", "顯示裝置類型與在線狀態"] },
      { phase: "同步狀態", steps: ["定期送出心跳", "輪詢遠端事件", "更新裝置清單與指令佇列"] },
      { phase: "安全控制", steps: ["每台裝置使用獨立 token", "高風險操作保留人工確認", "可關閉或重建 session"] },
    ];
  }

  if (intent === "deploy") {
    return [
      { phase: "檢查", steps: ["確認工作區狀態", "檢查首頁、動態 API 與靜態資源", "排除不應上傳的本機檔案"] },
      { phase: "提交", steps: ["建立清楚的 commit", "推送到 GitHub main", "確認遠端 commit 與本機一致"] },
      { phase: "部署", steps: ["使用既有 Netlify site", "部署 Netlify Functions 與前端檔案", "等待 production deploy ready"] },
      { phase: "驗證", steps: ["檢查公開首頁 HTTP 200", "呼叫 /api/state 確認動態 API", "回傳 GitHub 與 Netlify 連結"] },
    ];
  }

  if (intent === "research") {
    return [
      { phase: "定義", steps: ["確認研究問題", "列出比較條件", "決定輸出格式"] },
      { phase: "蒐集", steps: ["搜尋主要來源", "記錄可信來源", "標記日期與限制"] },
      { phase: "整理", steps: ["分群重點", "建立比較表", "寫出結論摘要"] },
      { phase: "交付", steps: ["產出報告", "補上引用", "列出下一步"] },
    ];
  }

  if (intent === "document") {
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

function planToMarkdown(plan) {
  return plan
    .map((column) => [`## ${column.phase}`, ...column.steps.map((step) => `- ${step}`)].join("\n"))
    .join("\n\n");
}

function createBrief(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n").filter(Boolean);
  const words = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const sentences = normalized.split(/[。.!?\n]/).map((item) => item.trim()).filter(Boolean);
  const actionLines = lines.filter((line) => /待辦|下一步|需要|請|必須|todo|should|must/i.test(line)).slice(0, 6);

  return {
    lineCount: lines.length,
    wordCount: words.length,
    charCount: normalized.length,
    summary: sentences.slice(0, 3),
    actionItems: actionLines,
    keywords: extractKeywords(normalized),
  };
}

function extractKeywords(text) {
  const matches = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) || [];
  const blocked = new Set(["這個", "一個", "以及", "可以", "目前", "我們", "你們", "資料", "內容"]);
  const counts = new Map();

  for (const item of matches) {
    const key = item.toLowerCase();
    if (blocked.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([keyword, count]) => ({ keyword, count }));
}
