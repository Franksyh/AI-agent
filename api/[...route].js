const hub = globalThis.__futureAssistantHub || {
  sessions: new Map(),
  codes: new Map(),
};

globalThis.__futureAssistantHub = hub;

export default async function handler(req, res) {
  const route = routeName(req);

  try {
    if (req.method === "GET" && route === "state") {
      return sendJson(res, createState(req));
    }

    if (req.method === "GET" && route === "workflows") {
      return sendJson(res, {
        ok: true,
        generatedAt: new Date().toISOString(),
        workflows: workflowTemplates(),
      });
    }

    if (req.method === "POST" && route === "chat") {
      const body = req.body || {};
      const message = cleanText(body.message);
      const mode = cleanText(body.mode || "confirm", 32);
      const plan = createPlan(message);

      return sendJson(res, {
        ok: true,
        dynamic: true,
        provider: "vercel",
        intent: detectIntent(message),
        mode,
        reply: createReply(message, plan, mode),
        plan,
        requestId: requestId(req),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && route === "plan") {
      const body = req.body || {};
      const goal = cleanText(body.goal);
      const plan = createPlan(goal);

      return sendJson(res, {
        ok: true,
        dynamic: true,
        provider: "vercel",
        goal,
        plan,
        markdown: planToMarkdown(plan),
        requestId: requestId(req),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && route === "brief") {
      const body = req.body || {};
      const text = cleanText(body.text);
      const name = cleanText(body.name || "未命名檔案", 120);

      return sendJson(res, {
        ok: true,
        dynamic: true,
        provider: "vercel",
        name,
        brief: createBrief(text),
        requestId: requestId(req),
        generatedAt: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && route === "remote") {
      const result = handleRemote(req.body || {}, req);
      return sendJson(res, result);
    }

    return sendJson(res, { ok: false, error: `Unknown API route: ${route}` }, 404);
  } catch (error) {
    return sendJson(
      res,
      {
        ok: false,
        error: error instanceof Error ? error.message : "API 發生未預期錯誤",
      },
      500,
    );
  }
}

function routeName(req) {
  const queryRoute = req.query?.route;
  if (Array.isArray(queryRoute)) return queryRoute[0] || "state";
  if (queryRoute) return queryRoute;
  const url = new URL(req.url || "/api/state", baseUrl(req));
  return url.pathname.replace(/^\/api\/?/, "") || "state";
}

function sendJson(res, data, status = 200) {
  res.status(status).setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data, null, 2));
}

function createState(req) {
  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    app: "Future Assistant",
    runtime: "Vercel Serverless Functions",
    apiVersion: "2026-06-10.vercel.multi-user.1",
    requestId: requestId(req),
    serverTime: new Date().toISOString(),
    activeSessions: hub.sessions.size,
    capabilities: {
      serverPlanning: true,
      dynamicChat: true,
      fileBriefing: true,
      workflowTemplates: true,
      remoteSessions: true,
      multiUserRemote: true,
      mobileRemote: true,
      desktopRemote: true,
      webRemote: true,
      staticFallback: true,
    },
  };
}

function requestId(req) {
  return req.headers["x-vercel-id"] || crypto.randomUUID();
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function cleanText(value, limit = 20000) {
  return String(value || "").trim().slice(0, limit);
}

function handleRemote(body, req) {
  const action = cleanText(body.action, 32);
  if (action === "create") return createRemoteSession(body, req);
  if (action === "join") return joinRemoteSession(body);
  if (action === "heartbeat") return heartbeatRemoteSession(body);
  if (action === "poll") return pollRemoteSession(body, req);
  if (action === "send") return sendRemoteCommand(body, req);
  if (action === "close") return closeRemoteSession(body, req);
  throw new Error("未知的遠端連線操作");
}

function createRemoteSession(body, req) {
  cleanupExpiredSessions();

  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const code = createUniqueCode();
  const device = createDevice(body, "host");
  const session = {
    id: sessionId,
    code,
    status: "waiting",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 6).toISOString(),
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
        message: `${device.name} 建立了多人連線 session`,
        payload: {},
        createdAt: now,
      },
    ],
  };

  hub.sessions.set(sessionId, session);
  hub.codes.set(code, sessionId);

  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    role: "host",
    deviceId: device.id,
    token: device.token,
    cursor: session.sequence,
    joinUrl: `${baseUrl(req)}/?session=${encodeURIComponent(code)}`,
    session: publicSession(session),
    requestId: requestId(req),
    generatedAt: now,
  };
}

function joinRemoteSession(body) {
  cleanupExpiredSessions();

  const code = cleanText(body.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) throw new Error("請提供配對碼");

  const sessionId = hub.codes.get(code);
  if (!sessionId) throw new Error("找不到這組配對碼");

  const session = hub.sessions.get(sessionId);
  assertSessionOpen(session);

  const device = createDevice(body, "guest");
  session.devices = upsertDevice(session.devices, device);
  session.status = "active";
  appendEvent(session, {
    type: "system",
    commandType: "device_joined",
    fromDeviceId: device.id,
    fromName: device.name,
    message: `${device.name} 已加入多人連線 session`,
    payload: { deviceType: device.type },
  });

  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    role: "guest",
    deviceId: device.id,
    token: device.token,
    cursor: session.sequence,
    session: publicSession(session),
    requestId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
  };
}

function heartbeatRemoteSession(body) {
  const { session, device } = authorizedSession(body);
  device.lastSeen = new Date().toISOString();
  device.name = cleanText(body.deviceName, 80) || device.name;
  device.type = normalizeDeviceType(body.deviceType);
  session.updatedAt = device.lastSeen;
  session.devices = upsertDevice(session.devices, device);

  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    session: publicSession(session),
    requestId: crypto.randomUUID(),
    generatedAt: device.lastSeen,
  };
}

function pollRemoteSession(body, req) {
  const { session, device } = authorizedSession(body);
  const cursor = Number(body.cursor || 0);
  const events = session.events
    .filter((event) => event.sequence > cursor && event.fromDeviceId !== device.id)
    .map(publicEvent);

  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    cursor: session.sequence,
    events,
    session: publicSession(session),
    requestId: requestId(req),
    generatedAt: new Date().toISOString(),
  };
}

function sendRemoteCommand(body, req) {
  const { session, device } = authorizedSession(body);
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

  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    cursor: session.sequence,
    session: publicSession(session),
    requestId: requestId(req),
    generatedAt: new Date().toISOString(),
  };
}

function closeRemoteSession(body, req) {
  const { session, device } = authorizedSession(body);
  session.status = "closed";
  appendEvent(session, {
    type: "system",
    commandType: "session_closed",
    fromDeviceId: device.id,
    fromName: device.name,
    message: `${device.name} 關閉了多人連線 session`,
    payload: {},
  });

  return {
    ok: true,
    dynamic: true,
    provider: "vercel",
    session: publicSession(session),
    requestId: requestId(req),
    generatedAt: new Date().toISOString(),
  };
}

function authorizedSession(body) {
  const sessionId = cleanText(body.sessionId, 80);
  const token = cleanText(body.token, 120);
  if (!sessionId || !token) throw new Error("缺少 session 或用戶 token");

  const session = hub.sessions.get(sessionId);
  assertSessionOpen(session);

  const device = session.devices.find((item) => item.token === token);
  if (!device) throw new Error("用戶驗證失敗");
  return { session, device };
}

function createUniqueCode() {
  for (let index = 0; index < 10; index += 1) {
    const code = randomCode();
    if (!hub.codes.has(code)) return code;
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
  if (type === "mobile") return "手機版用戶";
  if (type === "desktop") return "電腦版用戶";
  return "網頁版用戶";
}

function upsertDevice(devices, device) {
  const next = devices.filter((item) => item.id !== device.id && item.token !== device.token);
  next.push(device);
  return next.slice(-50);
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
  session.events = session.events.slice(-500);
}

function sanitizePayload(payload) {
  return {
    text: cleanText(payload.text, 2000),
    url: cleanText(payload.url, 1000),
  };
}

function assertSessionOpen(session) {
  if (!session) throw new Error("找不到多人連線 session");
  if (session.status === "closed") throw new Error("這個 session 已關閉");
  if (Date.parse(session.expiresAt) < Date.now()) throw new Error("這個 session 已過期");
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

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of hub.sessions.entries()) {
    if (Date.parse(session.expiresAt) < now || session.status === "closed") {
      hub.sessions.delete(sessionId);
      hub.codes.delete(session.code);
    }
  }
}

function workflowTemplates() {
  return [
    {
      icon: "users-round",
      title: "多人遠端連線",
      text: "建立配對碼，讓多位手機、電腦與網頁用戶加入同一個 session。",
      goal: "支援用戶多人連線，並支援手機版、電腦版與網頁版遠端連線功能",
    },
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
      text: "檢查檔案、提交 GitHub、部署 Vercel、驗證公開網址。",
      goal: "將目前資料夾同步至 GitHub 並部署到 Vercel，完成後回傳公開連結",
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
  if (message.includes("多人") || message.includes("用戶") || message.includes("遠端") || message.includes("手機") || message.includes("電腦") || message.includes("網頁")) return "remote";
  if (lower.includes("github") || lower.includes("netlify") || lower.includes("vercel") || message.includes("部署") || message.includes("同步")) return "deploy";
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
    remote: "我已把多人遠端連線拆成建立 session、多人加入、狀態同步與安全控制。",
    deploy: "我已把發布任務拆成 GitHub 與 Vercel 的動態部署流程。",
    research: "我已把研究任務拆成問題定義、資料蒐集、比較整理與交付。",
    document: "我已把文件任務拆成讀取、摘要、轉換與確認。",
    support: "我已把客服任務拆成辨識需求、產生草稿、建立待辦與追蹤。",
    general: "我已把你的目標拆成可執行的工作流程。",
  }[intent];

  return `${intro}\n\n目前模式：${modeCopy}。\n這次由 Vercel Serverless Function 即時產生 ${phaseCount} 個階段、${stepCount} 個步驟。`;
}

function createPlan(goal) {
  const text = goal || "支援用戶多人連線，並支援手機版、電腦版與網頁版遠端連線功能";
  const intent = detectIntent(text);

  if (intent === "remote") {
    return [
      { phase: "建立連線", steps: ["電腦版或網頁版建立主控 session", "產生配對碼與 QR code", "保存每位用戶 token"] },
      { phase: "多人加入", steps: ["手機版用戶用配對碼加入", "電腦版用戶用連線網址加入", "網頁版用戶直接從瀏覽器加入"] },
      { phase: "同步狀態", steps: ["每位用戶定期送出心跳", "多人事件進入同一個指令佇列", "所有用戶輪詢最新訊息與在線狀態"] },
      { phase: "安全控制", steps: ["每位用戶使用獨立 token", "高風險操作保留人工確認", "主控端可關閉或重建 session"] },
    ];
  }

  if (intent === "deploy") {
    return [
      { phase: "檢查", steps: ["確認工作區狀態", "檢查 Vercel API 與靜態資源", "排除不應上傳的本機檔案"] },
      { phase: "提交", steps: ["建立清楚的 commit", "推送到 GitHub main", "確認遠端 commit 與本機一致"] },
      { phase: "部署", steps: ["使用 Vercel 部署目前 GitHub 專案", "啟用 /api/* 動態端點", "等待 production deploy ready"] },
      { phase: "驗證", steps: ["檢查公開首頁 HTTP 200", "呼叫 /api/state 確認 Vercel 動態 API", "測試多人 session 建立、加入與事件同步"] },
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
