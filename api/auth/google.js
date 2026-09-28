import {
  OwnerAuthError,
  authenticateGoogleOwner,
  clearGoogleOwnerCookie,
  googleOAuthConfig,
  ownerLoginStatus,
} from "../../lib/google-owner-auth.js";

export default function googleOAuthStatus(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "POST") {
    void handleOwnerSession(req, res);
    return;
  }
  if (req.method !== "GET") {
    res.status(405).send(JSON.stringify({ ok: false, error: "只支援 GET 與 POST" }));
    return;
  }
  const requestId = req.headers?.["x-vercel-id"] || globalThis.crypto?.randomUUID?.() || String(Date.now());
  res.status(200).send(JSON.stringify({
    ok: true,
    dynamic: true,
    provider: "vercel",
    generatedAt: new Date().toISOString(),
    requestId,
    googleOAuth: googleOAuthConfig(),
    ownerLogin: ownerLoginStatus(),
  }));
}

async function handleOwnerSession(req, res) {
  const contentType = String(req.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    res.status(415).send(JSON.stringify({ ok: false, error: "登入要求必須使用 JSON。" }));
    return;
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (body.action === "logout") {
    res.setHeader("Set-Cookie", clearGoogleOwnerCookie());
    res.status(200).send(JSON.stringify({ ok: true, authenticated: false }));
    return;
  }
  if (body.action !== "login") {
    res.status(400).send(JSON.stringify({ ok: false, error: "未知的登入操作。" }));
    return;
  }

  try {
    const session = await authenticateGoogleOwner(body.credential);
    res.setHeader("Set-Cookie", session.cookie);
    res.status(200).send(JSON.stringify({ ok: true, authenticated: true, email: session.owner.email }));
  } catch (error) {
    const status = error instanceof OwnerAuthError ? error.status : 401;
    res.status(status).send(JSON.stringify({
      ok: false,
      error: error instanceof OwnerAuthError ? error.message : "Google 身分驗證失敗，請重新登入。",
    }));
  }
}
