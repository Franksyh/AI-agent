import assert from "node:assert/strict";
import test from "node:test";
import googleOAuthStatus from "../api/auth/google.js";
import handler from "../api/[...route].js";

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test("Vercel catch-all keeps nested Google OAuth route segments", async () => {
  const response = createResponse();
  await handler({
    method: "GET",
    url: "/api/auth/google",
    headers: { host: "future-assistant-jade.vercel.app" },
    query: { route: ["auth", "google"] },
  }, response);

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.googleOAuth.enabled, false);
});

test("explicit Vercel Google OAuth status endpoint is reachable without credentials", async () => {
  const response = createResponse();
  await googleOAuthStatus({
    method: "GET",
    headers: { "x-vercel-id": "test-request" },
  }, response);

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.requestId, "test-request");
  assert.deepEqual(body.googleOAuth, {
    enabled: false,
    reason: "尚未在部署平台設定 GOOGLE_CLIENT_ID。",
  });
});

test("Vercel owner logout clears the secure owner cookie", async () => {
  const response = createResponse();
  await googleOAuthStatus({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { action: "logout" },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).authenticated, false);
  assert.match(response.headers["set-cookie"], /__Secure-mini-codex-owner=; Max-Age=0/);
  assert.match(response.headers["set-cookie"], /HttpOnly; Secure; SameSite=Strict/);
});

test("Vercel owner login does not grant a role before deployment configuration exists", async () => {
  const response = createResponse();
  await googleOAuthStatus({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { action: "login", credential: "header.payload.signature" },
  }, response);

  assert.equal(response.statusCode, 503);
  assert.match(JSON.parse(response.body).error, /GOOGLE_CLIENT_ID/);
  assert.equal(response.headers["set-cookie"], undefined);
});

test("public Cloud access identifies visitors separately from local Mini ownership", async () => {
  const response = createResponse();
  await handler({
    method: "GET",
    url: "/api/state",
    headers: { host: "future-assistant-jade.vercel.app" },
  }, response);

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.access.publicRole, "雲端訪客");
  assert.match(body.access.publicDescription, /Windows 本機 Mini/);
  assert.equal(body.access.owner.label, "owner");
});
