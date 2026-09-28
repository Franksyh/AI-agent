import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID_PATTERN = /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i;
const OWNER_COOKIE_NAME = "__Secure-mini-codex-owner";
const MAX_TOKEN_LENGTH = 8192;
const googleAuthClient = new OAuth2Client();

export class OwnerAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "OwnerAuthError";
    this.status = status;
  }
}

export function googleOAuthConfig(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim().slice(0, 240);
  const validClientId = GOOGLE_CLIENT_ID_PATTERN.test(clientId);
  return validClientId
    ? {
      enabled: true,
      provider: "google",
      clientId,
      scope: "openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly",
      flow: "browser_popup_token",
      persistence: "瀏覽器工作階段；Mini Codex 不保存 Google access token。",
    }
    : { enabled: false, reason: "尚未在部署平台設定 GOOGLE_CLIENT_ID。" };
}

export function ownerLoginStatus(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || "").trim().slice(0, 240);
  const ownerEmail = String(env.OWNER_GOOGLE_EMAIL || "").trim().toLowerCase().slice(0, 254);
  const validClientId = GOOGLE_CLIENT_ID_PATTERN.test(clientId);
  const validOwnerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail);

  if (!validClientId) {
    return { enabled: false, reason: "尚未設定有效的 GOOGLE_CLIENT_ID。" };
  }
  if (!validOwnerEmail) {
    return { enabled: false, reason: "尚未設定擁有者的 OWNER_GOOGLE_EMAIL。" };
  }
  return { enabled: true, provider: "google", clientId, flow: "google_id_token_http_only_cookie" };
}

export async function authenticateGoogleOwner(credential, {
  env = process.env,
  client = googleAuthClient,
} = {}) {
  const config = ownerLoginStatus(env);
  if (!config.enabled) throw new OwnerAuthError(config.reason, 503);
  if (typeof credential !== "string" || credential.length > MAX_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)) {
    throw new OwnerAuthError("Google 登入憑證格式無效，請重新登入。", 400);
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: config.clientId });
    payload = ticket.getPayload();
  } catch {
    throw new OwnerAuthError("Google 身分驗證失敗，請重新登入。", 401);
  }

  const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!payload?.sub || payload.email_verified !== true || email !== String(env.OWNER_GOOGLE_EMAIL).trim().toLowerCase()) {
    throw new OwnerAuthError("這個 Google 帳號不是指定的網站擁有者帳號。", 403);
  }

  const expiresAt = Number(payload.exp || 0);
  const maxAge = Math.min(3600, expiresAt - Math.floor(Date.now() / 1000));
  if (!Number.isInteger(maxAge) || maxAge <= 0) {
    throw new OwnerAuthError("Google 登入憑證已到期，請重新登入。", 401);
  }

  return {
    owner: { email, subject: payload.sub },
    cookie: `${OWNER_COOKIE_NAME}=${credential}; Max-Age=${maxAge}; Path=/api; HttpOnly; Secure; SameSite=Strict`,
  };
}

export function clearGoogleOwnerCookie() {
  return `${OWNER_COOKIE_NAME}=; Max-Age=0; Path=/api; HttpOnly; Secure; SameSite=Strict`;
}

export async function googleOwnerFromRequest(req, options = {}) {
  const cookieHeader = req?.headers?.cookie || req?.headers?.get?.("cookie") || "";
  const prefix = `${OWNER_COOKIE_NAME}=`;
  const value = String(cookieHeader).split(/;\s*/).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!value) return null;
  try {
    return (await authenticateGoogleOwner(value, options)).owner;
  } catch {
    return null;
  }
}
