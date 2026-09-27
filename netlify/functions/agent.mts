import { getDeployStore, getStore } from "@netlify/blobs";

const sourceCache = globalThis.__miniCodexSourceCache || {
  expiresAt: 0,
  value: null,
};

globalThis.__miniCodexSourceCache = sourceCache;

const SOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_REMOTE_DEVICES = 8;
const MEMBER_COMMAND_TYPES = new Set(["text", "ping", "request"]);
const OWNER_COMMAND_TYPES = new Set(["text", "ping", "request", "open_url", "approval"]);

const SOURCE_CATALOG = Object.freeze([
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    repository: "openai/codex",
    url: "https://github.com/openai/codex",
    category: "coding agent",
    note: "以公開儲存庫中繼資料供擁有者審查。",
  },
  {
    id: "openai-gpt-oss",
    name: "OpenAI gpt-oss",
    repository: "openai/gpt-oss",
    url: "https://github.com/openai/gpt-oss",
    category: "open-weight model",
    note: "模型需由擁有者自行選擇並在本機或受控環境部署。",
  },
  {
    id: "google-gemini-cli",
    name: "Google Gemini CLI",
    repository: "google-gemini/gemini-cli",
    url: "https://github.com/google-gemini/gemini-cli",
    category: "coding agent",
    note: "僅列為候選來源，不會代替使用者登入 Google 帳號。",
  },
  {
    id: "perplexity-bumblebee",
    name: "Perplexity Bumblebee",
    repository: "perplexityai/bumblebee",
    url: "https://github.com/perplexityai/bumblebee",
    category: "research agent",
    note: "以公開中繼資料追蹤，需由擁有者確認用途與授權。",
  },
  {
    id: "apple-intelligence-cli",
    name: "Apple Intelligence CLI",
    repository: "onmyway133/apple-intelligence-cli",
    url: "https://github.com/onmyway133/apple-intelligence-cli",
    category: "Apple reference",
    note: "僅作為 Apple 平台參考，不提供 Windows 上的 Siri 控制。",
  },
  {
    id: "siri-ultra",
    name: "Siri Ultra",
    repository: "fatwang2/siri-ultra",
    url: "https://github.com/fatwang2/siri-ultra",
    category: "Apple reference",
    note: "僅作為候選參考；整合前必須由擁有者審核。",
  },
]);

const PROVIDER_CATALOG = Object.freeze([
  {
    id: "codex",
    name: "OpenAI Codex",
    status: "local_companion_required",
    capability: "透過本機 Mini Codex companion 使用 Codex App Server。",
    accountLink: "此公開 API 不持有 OpenAI 登入或 API 金鑰。",
  },
  {
    id: "github",
    name: "GitHub",
    status: "public_metadata_only",
    capability: "來源端點只讀取受信任儲存庫的公開中繼資料。",
    accountLink: "GitHub 帳號授權尚未在此公開服務設定。",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    status: "not_configured",
    capability: "可由使用者在自己的環境安裝 Gemini CLI 或設定受控 API。",
    accountLink: "Google OAuth 尚未設定；服務不會要求或儲存密碼。",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    status: "not_configured",
    capability: "需要擁有者自行設定 Perplexity API 憑證。",
    accountLink: "此公開服務沒有 Perplexity 帳號連線。",
  },
  {
    id: "apple",
    name: "Apple Intelligence / Siri",
    status: "reference_only",
    capability: "Apple 專案僅列為來源參考；網頁服務不能控制 Siri 或 Apple 裝置。",
    accountLink: "未連結 Apple 帳號。",
  },
  {
    id: "gpt-oss",
    name: "gpt-oss",
    status: "self_hosting_required",
    capability: "開放權重模型需要由擁有者自行準備符合需求的推論環境。",
    accountLink: "此服務沒有代管模型或 GPU。",
  },
]);

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "") || "state";

  try {
    if (req.method === "GET" && route === "state") {
      return jsonResponse(createState(context));
    }

    if (req.method === "GET" && route === "sources") {
      return jsonResponse(await createSourcesResponse(context, url));
    }

    if (req.method === "GET" && route === "providers") {
      return jsonResponse(createProvidersResponse(context));
    }

    if (req.method === "GET" && route === "auth/google") {
      return jsonResponse(createGoogleOAuthResponse(context));
    }

    if (req.method === "GET" && route === "access") {
      return jsonResponse(createAccessResponse(context));
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
    const status = error instanceof ApiError ? error.status : 500;
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "API 發生未預期錯誤",
      },
      { status },
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
    provider: "netlify",
    app: "Mini Codex",
    runtime: "Netlify Functions + Blobs",
    apiVersion: "2026-09-27.netlify.mini-codex.access.2",
    requestId: getRequestId(context),
    serverTime: new Date().toISOString(),
    access: accessSummary(),
    capabilities: {
      serverPlanning: true,
      dynamicChat: true,
      fileBriefing: true,
      workflowTemplates: true,
      remoteSessions: true,
      multiUserRemote: true,
      remoteSessionDurability: "netlify_blobs",
      roleBasedRemote: true,
      ownerCanCloseSession: true,
      memberCommandsRestricted: true,
      mobileRemote: true,
      desktopRemote: true,
      webRemote: true,
      pwaInstall: true,
      sourceCatalog: true,
      sourceMetadataFromGitHub: true,
      sourceForceRefresh: true,
      publicMetadataQualityScore: true,
      providerCatalog: true,
      sourceAutoInstall: false,
      cloudComputerControl: false,
      cloudAccountLinking: googleOAuthConfig().enabled,
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

function accessSummary() {
  return {
    owner: {
      label: "owner",
      assignment: "建立遠端 session 的裝置",
      capabilities: ["read", "edit", "send_text", "send_ping", "send_request", "open_url", "request_approval", "close_session"],
    },
    member: {
      label: "member",
      assignment: "用配對碼加入的裝置",
      capabilities: ["read", "send_text", "send_ping", "send_request"],
      blocked: ["open_url", "request_approval", "close_session", "computer_control"],
    },
    enforcement: "角色與命令限制會在遠端 API 伺服器端驗證。",
    authentication: "每個 session 裝置使用獨立 bearer token；此公開服務尚未設定帳號登入。",
  };
}

function createProvidersResponse(context) {
  return {
    ok: true,
    dynamic: true,
    provider: "netlify",
    generatedAt: new Date().toISOString(),
    requestId: getRequestId(context),
    note: "供應商清單描述目前可用的整合狀態，不表示服務已連結第三方帳號。",
    providers: providerCatalog(),
  };
}

function createGoogleOAuthResponse(context) {
  return {
    ok: true,
    dynamic: true,
    provider: "netlify",
    generatedAt: new Date().toISOString(),
    requestId: getRequestId(context),
    googleOAuth: googleOAuthConfig(),
  };
}

function providerCatalog() {
  const googleOAuth = googleOAuthConfig();
  return PROVIDER_CATALOG.map((provider) => {
    if (provider.id !== "gemini") return provider;
    if (!googleOAuth.enabled) return provider;
    return {
      ...provider,
      status: "oauth_ready",
      capability: "可在這個瀏覽器使用 Google OAuth 確認帳號；Gemini CLI 或 API 仍須由擁有者自行設定。",
      accountLink: "可連結 Google 帳號。存取權杖只留在瀏覽器記憶體，不會傳送或保存到 Mini Codex 伺服器。",
      oauth: googleOAuth,
    };
  });
}

function googleOAuthConfig() {
  const clientId = cleanText(process.env.GOOGLE_CLIENT_ID, 240);
  const validClientId = /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId);
  return validClientId
    ? {
      enabled: true,
      provider: "google",
      clientId,
      scope: "openid email profile",
      flow: "browser_popup_token",
      persistence: "瀏覽器工作階段；Mini Codex 不保存 Google access token。",
    }
    : {
      enabled: false,
      reason: "尚未在部署平台設定 GOOGLE_CLIENT_ID。",
    };
}

function createAccessResponse(context) {
  return {
    ok: true,
    dynamic: true,
    provider: "netlify",
    generatedAt: new Date().toISOString(),
    requestId: getRequestId(context),
    access: accessSummary(),
  };
}

async function createSourcesResponse(context, url) {
  const catalog = await getSourceCatalog({ force: url.searchParams.get("refresh") === "1" });
  return {
    ok: true,
    dynamic: true,
    provider: "netlify",
    generatedAt: catalog.generatedAt,
    requestId: getRequestId(context),
    cache: catalog.cache,
    refreshAfterSeconds: Math.floor(SOURCE_CACHE_TTL_MS / 1000),
    policy: {
      metadata: "僅向 GitHub Public API 讀取列出的受信任儲存庫中繼資料；快速分數是公開中繼資料的規則式篩選，不是 AI 程式碼審查。",
      codeExecution: "不下載、安裝或執行任何候選來源的程式碼。",
      approval: "任何採用、下載或整合都必須由擁有者在本機審核後執行。",
    },
    sources: catalog.sources,
  };
}

async function getSourceCatalog({ force = false } = {}) {
  const now = Date.now();
  if (sourceCache.value && sourceCache.expiresAt > now && !force) {
    return { ...sourceCache.value, cache: "memory" };
  }


  const settled = await Promise.allSettled(SOURCE_CATALOG.map(fetchGitHubSourceMetadata));
  const sources = settled.map((result, index) =>
    result.status === "fulfilled" ? result.value : fallbackSource(SOURCE_CATALOG[index]),
  );
  const value = {
    generatedAt: new Date().toISOString(),
    sources,
  };
  sourceCache.value = value;
  sourceCache.expiresAt = Date.now() + SOURCE_CACHE_TTL_MS;
  return { ...value, cache: "refreshed" };
}

async function fetchGitHubSourceMetadata(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const response = await fetch(`https://api.github.com/repos/${source.repository}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Mini-Codex-Source-Review",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub metadata request failed: ${response.status}`);

    const metadata = await response.json();
    const quality = publicQualityScore(metadata);
    return {
      ...source,
      reviewStatus: "owner_review_required",
      metadataStatus: "live",
      metadataSource: "github_public_api",
      description: cleanText(metadata.description, 500),
      defaultBranch: cleanText(metadata.default_branch, 120) || "unknown",
      license: cleanText(metadata.license?.spdx_id, 120) || "NOASSERTION",
      latestPushAt: safeTimestamp(metadata.pushed_at),
      updatedAt: safeTimestamp(metadata.updated_at),
      archived: Boolean(metadata.archived),
      fork: Boolean(metadata.fork),
      stargazersCount: Number(metadata.stargazers_count || 0),
      forksCount: Number(metadata.forks_count || 0),
      openIssuesCount: Number(metadata.open_issues_count || 0),
      score: quality.score,
      qualitySignals: quality.signals,
      scoreMethod: "public_metadata_rule_based",
    };
  } catch {
    return fallbackSource(source);
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackSource(source) {
  return {
    ...source,
    reviewStatus: "metadata_unavailable",
    metadataStatus: "fallback",
    metadataSource: "catalog_fallback",
    description: "GitHub 公開中繼資料暫時無法讀取；請稍後重新整理後再審核。",
    defaultBranch: "unknown",
    license: "unknown",
    latestPushAt: null,
    updatedAt: null,
    archived: null,
    fork: null,
    stargazersCount: null,
    forksCount: null,
    openIssuesCount: null,
    score: null,
    qualitySignals: [],
    scoreMethod: "unavailable",
  };
}

function publicQualityScore(metadata) {
  let score = 0;
  const signals = [];
  const license = cleanText(metadata.license?.spdx_id, 120);
  const pushedAt = Date.parse(metadata.pushed_at || "");
  const ageDays = Number.isFinite(pushedAt) ? (Date.now() - pushedAt) / 86400000 : Infinity;
  const stars = Number(metadata.stargazers_count || 0);

  if (license && license !== "NOASSERTION") {
    score += 25;
    signals.push("有公開 SPDX 授權");
  }
  if (!metadata.archived) {
    score += 15;
    signals.push("未封存");
  }
  if (!metadata.fork) {
    score += 10;
    signals.push("非 fork 專案");
  }
  if (ageDays <= 90) {
    score += 25;
    signals.push("90 天內有更新");
  } else if (ageDays <= 365) {
    score += 15;
    signals.push("一年內有更新");
  }
  if (stars >= 1000) {
    score += 25;
    signals.push("公開社群追蹤達 1,000+");
  } else if (stars >= 100) {
    score += 15;
    signals.push("公開社群追蹤達 100+");
  } else if (stars >= 10) {
    score += 5;
    signals.push("有公開社群追蹤");
  }
  return { score: Math.min(score, 100), signals };
}

function safeTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function getRemoteStore(context) {
  const deployContext = context?.deploy?.context;
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
  throw new ApiError("未知的遠端連線操作", 400);
}

async function createRemoteSession(body, url, context) {
  const store = getRemoteStore(context);
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const code = await createUniqueCode(store);
  const device = createDevice(body, "owner");
  const session = {
    id: sessionId,
    code,
    ownerDeviceId: device.id,
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
    role: "owner",
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
  const store = getRemoteStore(context);
  const code = cleanText(body.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) throw new ApiError("請提供配對碼", 400);

  const mapping = await store.get(codeKey(code), { type: "json" });
  if (!mapping?.sessionId) throw new ApiError("找不到這組配對碼", 404);

  let session;
  try {
    session = await loadSession(store, mapping.sessionId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await deletePairingCodeIfMatches(store, code, mapping.sessionId);
    }
    throw error;
  }
  await assertSessionOpen(store, session);
  normalizeSessionRoles(session);
  assertDeviceCapacity(session);

  const device = createDevice(body, "member");
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
    role: "member",
    deviceId: device.id,
    token: device.token,
    cursor: session.sequence,
    session: publicSession(session),
    requestId: getRequestId(context),
    generatedAt: new Date().toISOString(),
  };
}

async function heartbeatRemoteSession(body, context) {
  const { store, session, device } = await authorizedSession(body, context);
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
  const { session, device } = await authorizedSession(body, context);
  const cursor = Number(body.cursor || 0);
  const events = session.events
    .filter((event) => event.sequence > cursor && event.fromDeviceId !== device.id && eventIsVisibleToDevice(event, device))
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
  const { store, session, device } = await authorizedSession(body, context);
  const commandType = normalizeCommandType(body.commandType);
  assertCommandAllowed(device, commandType);
  const payload = sanitizePayload(body.payload || {}, commandType);
  const message = payload.text || commandType;

  appendEvent(session, {
    type: "command",
    commandType,
    target: device.role === "member" ? "owner" : normalizeTarget(body.target),
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
  const { store, session, device } = await authorizedSession(body, context);
  assertOwner(session, device);
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

async function authorizedSession(body, context) {
  const store = getRemoteStore(context);
  const sessionId = cleanText(body.sessionId, 80);
  const token = cleanText(body.token, 120);
  if (!sessionId || !token) throw new ApiError("缺少 session 或裝置 token", 401);

  const session = await loadSession(store, sessionId);
  await assertSessionOpen(store, session);
  normalizeSessionRoles(session);

  const device = session.devices.find((item) => item.token === token);
  if (!device) throw new ApiError("裝置驗證失敗", 401);
  return { store, session, device };
}

async function createUniqueCode(store) {
  for (let index = 0; index < 10; index += 1) {
    const code = randomCode();
    const existing = await store.get(codeKey(code), { type: "json" });
    if (!existing) return code;
  }
  throw new ApiError("暫時無法產生配對碼，請再試一次", 503);
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

function normalizeSessionRoles(session) {
  if (!session || !Array.isArray(session.devices)) return;
  const owner = session.devices.find((device) => device.role === "owner" || device.role === "host") || session.devices[0];
  if (!owner) return;

  session.ownerDeviceId = session.ownerDeviceId || owner.id;
  for (const device of session.devices) {
    device.role = device.id === session.ownerDeviceId ? "owner" : "member";
  }
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
  return next;
}

function assertDeviceCapacity(session) {
  if (session.devices.length >= MAX_REMOTE_DEVICES) {
    throw new ApiError(`這個 session 最多可連線 ${MAX_REMOTE_DEVICES} 台裝置，請由擁有者先關閉或重建連線`, 409);
  }
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

function normalizeCommandType(value) {
  const commandType = cleanText(value || "text", 32).toLowerCase();
  if (!OWNER_COMMAND_TYPES.has(commandType)) throw new ApiError("不支援的遠端命令類型", 400);
  return commandType;
}

function assertCommandAllowed(device, commandType) {
  if (device.role === "owner") return;
  if (device.role !== "member" || !MEMBER_COMMAND_TYPES.has(commandType)) {
    throw new ApiError("一般成員只能傳送文字、連線測試或請求訊息", 403);
  }
}

function assertOwner(session, device) {
  if (device.role !== "owner" || session.ownerDeviceId !== device.id) {
    throw new ApiError("只有建立此 session 的擁有者可以關閉連線", 403);
  }
}

function normalizeTarget(value) {
  const target = cleanText(value || "all", 32);
  return target === "owner" || target === "all" ? target : "all";
}

function sanitizePayload(payload, commandType) {
  const text = cleanText(payload.text, 2000);
  if (commandType !== "open_url") return { text, url: "" };

  const url = normalizeHttpUrl(payload.url || text);
  if (!url) throw new ApiError("開啟網址命令只接受有效的 http 或 https 網址", 400);
  return { text, url };
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(cleanText(value, 1000));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

async function loadSession(store, sessionId) {
  const session = await store.get(sessionKey(sessionId), { type: "json" });
  if (!session) throw new ApiError("找不到遠端 session", 404);
  return session;
}

async function saveSession(store, session) {
  await store.setJSON(sessionKey(session.id), session);
}

async function assertSessionOpen(store, session) {
  if (!session || typeof session !== "object") throw new ApiError("找不到遠端 session", 404);
  if (!Array.isArray(session.devices) || !Array.isArray(session.events)) {
    throw new ApiError("遠端 session 資料無效", 409);
  }
  if (session.status === "closed") {
    await purgeClosedOrExpiredSession(store, session);
    throw new ApiError("這個 session 已關閉", 410);
  }
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    await purgeClosedOrExpiredSession(store, session);
    throw new ApiError("這個 session 已過期", 410);
  }
}

async function purgeClosedOrExpiredSession(store, session) {
  const operations = [store.delete(sessionKey(session.id))];
  const code = cleanText(session.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code) {
    try {
      const mapping = await store.get(codeKey(code), { type: "json" });
      if (!mapping || mapping.sessionId === session.id) operations.push(store.delete(codeKey(code)));
    } catch {
      // Keep the 410 response even if best-effort pairing-code cleanup cannot read the store.
    }
  }
  await Promise.allSettled(operations);
}

async function deletePairingCodeIfMatches(store, code, sessionId) {
  try {
    const mapping = await store.get(codeKey(code), { type: "json" });
    if (!mapping || mapping.sessionId === sessionId) await store.delete(codeKey(code));
  } catch {
    // A stale code is not allowed to turn a normal 404 response into a server error.
  }
}

function eventIsVisibleToDevice(event, device) {
  const target = event.target || "all";
  return target === "all" || target === device.role || target === device.id || (target === "host" && device.role === "owner");
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
    ownerDeviceId: session.ownerDeviceId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    sequence: session.sequence,
    access: {
      ownerRole: "owner",
      memberRole: "member",
      memberCommands: Array.from(MEMBER_COMMAND_TYPES),
      deviceLimit: MAX_REMOTE_DEVICES,
    },
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
      icon: "sparkles",
      title: "AI 智能助手升級",
      text: "整合跨平台入口、任務規劃、多人遠端連線、文件摘要與安全確認。",
      goal: "將產品升級為跨手機、電腦、網頁的 AI 智能助手，具備多人遠端連線、任務規劃、文件摘要與安全確認",
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
  if (
    message.includes("智能助手") ||
    message.includes("超越") ||
    message.includes("產品升級") ||
    (message.includes("打造") && message.includes("助手")) ||
    (lower.includes("ai") && message.includes("助手"))
  ) {
    return "assistant";
  }
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
    assistant: "我已把智能助手升級拆成核心定位、跨平台體驗、智能工作流、多人遠端與驗證成長。",
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

  if (intent === "assistant") {
    return [
      { phase: "核心定位", steps: ["從聊天頁升級成能理解目標、規劃步驟、使用工具與驗證成果的智能助手", "保留觀察、確認、執行三種安全模式", "把手機、電腦、網頁整合成同一個入口"] },
      { phase: "跨平台體驗", steps: ["手機版支援 QR code 加入 session 與 PWA 安裝", "電腦版作為主控端審核高風險操作", "網頁版免安裝使用動態 API 與多人連線"] },
      { phase: "智能工作流", steps: ["任務規劃器輸出階段與待辦", "文件摘要器整理重點與待辦線索", "自動化模板重複執行常見工作"] },
      { phase: "多人遠端", steps: ["每位用戶有獨立 token", "多人事件進入同一個指令佇列", "同步在線狀態、配對碼與遠端訊息"] },
      { phase: "驗證成長", steps: ["檢查公開網址與 /api/state", "追蹤連線人數與任務步驟", "逐步加入真實工具串接與權限管理"] },
    ];
  }

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
