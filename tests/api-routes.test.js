import assert from "node:assert/strict";
import test from "node:test";
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
