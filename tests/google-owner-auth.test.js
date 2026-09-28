import assert from "node:assert/strict";
import test from "node:test";
import {
  OwnerAuthError,
  authenticateGoogleOwner,
  googleOwnerFromRequest,
  ownerLoginStatus,
} from "../lib/google-owner-auth.js";

const env = {
  GOOGLE_CLIENT_ID: "1234567890-example.apps.googleusercontent.com",
  OWNER_GOOGLE_EMAIL: "owner@example.com",
};

function makeClient(payload) {
  const calls = [];
  return {
    calls,
    async verifyIdToken(options) {
      calls.push(options);
      return { getPayload: () => payload };
    },
  };
}

function futureExpiry() {
  return Math.floor(Date.now() / 1000) + 1800;
}

test("owner login stays disabled until both the web client and owner email are configured", () => {
  assert.equal(ownerLoginStatus({}).enabled, false);
  assert.equal(ownerLoginStatus({ ...env, OWNER_GOOGLE_EMAIL: "" }).enabled, false);
  assert.equal(ownerLoginStatus(env).enabled, true);
});

test("Google owner login verifies the expected audience and creates a secure session cookie", async () => {
  const client = makeClient({ sub: "google-subject", email: "OWNER@example.com", email_verified: true, exp: futureExpiry() });
  const session = await authenticateGoogleOwner("header.payload.signature", { env, client });

  assert.equal(client.calls[0].audience, env.GOOGLE_CLIENT_ID);
  assert.equal(session.owner.email, "owner@example.com");
  assert.match(session.cookie, /^__Secure-mini-codex-owner=header\.payload\.signature;/);
  assert.match(session.cookie, /HttpOnly; Secure; SameSite=Strict/);
  const result = await googleOwnerFromRequest({ headers: { cookie: session.cookie.split(";")[0] } }, { env, client });
  assert.equal(result.email, "owner@example.com");
});

test("owner login rejects unverified emails and any account outside the owner allowlist", async () => {
  const unverified = makeClient({ sub: "s1", email: env.OWNER_GOOGLE_EMAIL, email_verified: false, exp: futureExpiry() });
  await assert.rejects(
    authenticateGoogleOwner("header.payload.signature", { env, client: unverified }),
    (error) => error instanceof OwnerAuthError && error.status === 403,
  );

  const otherAccount = makeClient({ sub: "s2", email: "other@example.com", email_verified: true, exp: futureExpiry() });
  await assert.rejects(
    authenticateGoogleOwner("header.payload.signature", { env, client: otherAccount }),
    (error) => error instanceof OwnerAuthError && error.status === 403,
  );
});

test("owner login rejects malformed, unverifiable, and expired credentials", async () => {
  await assert.rejects(authenticateGoogleOwner("not-a-jwt", { env }), (error) => error.status === 400);
  const rejected = { async verifyIdToken() { throw new Error("invalid signature"); } };
  await assert.rejects(
    authenticateGoogleOwner("header.payload.signature", { env, client: rejected }),
    (error) => error instanceof OwnerAuthError && error.status === 401,
  );
  const expired = makeClient({ sub: "s3", email: env.OWNER_GOOGLE_EMAIL, email_verified: true, exp: 1 });
  await assert.rejects(
    authenticateGoogleOwner("header.payload.signature", { env, client: expired }),
    (error) => error instanceof OwnerAuthError && error.status === 401,
  );
});
