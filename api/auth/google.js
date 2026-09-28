export default function googleOAuthStatus(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.status(405).send(JSON.stringify({ ok: false, error: "只支援 GET" }));
    return;
  }

  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim().slice(0, 240);
  const enabled = /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId);
  const requestId = req.headers?.["x-vercel-id"] || globalThis.crypto?.randomUUID?.() || String(Date.now());
  res.status(200).send(JSON.stringify({
    ok: true,
    dynamic: true,
    provider: "vercel",
    generatedAt: new Date().toISOString(),
    requestId,
    googleOAuth: enabled
      ? {
        enabled: true,
        provider: "google",
        clientId,
        scope: "openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly",
        flow: "browser_popup_token",
        persistence: "瀏覽器工作階段；Mini Codex 不保存 Google access token。",
      }
      : { enabled: false, reason: "尚未在部署平台設定 GOOGLE_CLIENT_ID。" },
  }));
}
