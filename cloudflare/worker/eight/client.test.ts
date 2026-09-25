import assert from "node:assert/strict";
import test from "node:test";
import { EightClient, EightApiError } from "./index.ts";
import type { EightToken } from "./types.ts";

const token: EightToken = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 0,
  userId: "user-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deviceResponse() {
  return jsonResponse({
    result: {
      leftHeatingLevel: 7,
      leftTargetHeatingLevel: 9,
      leftNowHeating: true,
      leftHeatingDuration: 120,
      rightHeatingLevel: -4,
      rightTargetHeatingLevel: -6,
      rightNowHeating: false,
      rightHeatingDuration: 0,
    },
  });
}

test("login and refresh return stored token fields and use the expected grants", async () => {
  const requests: Array<{ url: string; body: Record<string, string> }> = [];
  const client = new EightClient({
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        access_token: "a2",
        refresh_token: "r2",
        expires_in: 3600,
        userId: "login-user",
      });
    },
  });

  const loggedIn = await client.login("person@example.com", "pw");
  const refreshed = await client.refresh("r2", "existing-user");

  assert.equal(loggedIn.userId, "login-user");
  assert.equal(loggedIn.accessToken, "a2");
  assert.equal(loggedIn.refreshToken, "r2");
  assert.ok(loggedIn.expiresAt > Date.now());
  assert.equal(refreshed.userId, "existing-user");
  assert.equal(requests[0]?.body.grant_type, "password");
  assert.equal(requests[0]?.body.username, "person@example.com");
  assert.equal(requests[1]?.body.grant_type, "refresh_token");
  assert.equal(requests[1]?.body.refresh_token, "r2");
});

test("heating status selects the requested user side, with legacy solo behavior", async () => {
  for (const [requestedSide, expectedSide, expectedLevel] of [
    ["left", "left", 7],
    ["right", "right", -4],
    ["solo", "solo", -4],
  ] as const) {
    const urls: string[] = [];
    const client = new EightClient({
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/users/me")) {
          return jsonResponse({
            user: { devices: ["bed id"], currentDevice: { side: requestedSide } },
          });
        }
        return deviceResponse();
      },
    });

    const status = await client.getHeatingStatus(token);
    assert.equal(status.side, expectedSide);
    assert.equal(status.heatingLevel, expectedLevel);
    assert.equal(urls.length, 2);
    assert.ok(urls[1]?.includes("bed%20id"));
  }
});

test("GET retries one transient failure and throws after the bounded retry", async () => {
  let calls = 0;
  const client = new EightClient({
    fetch: async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    },
  });

  await assert.rejects(client.getHeatingStatus(token), EightApiError);
  assert.equal(calls, 2);
});

test("invalid device telemetry fails closed before a scheduler command", async () => {
  const client = new EightClient({
    fetch: async (input) =>
      String(input).endsWith("/users/me")
        ? jsonResponse({ user: { devices: ["bed"], currentDevice: { side: "left" } } })
        : jsonResponse({ result: { leftNowHeating: true } }),
  });
  await assert.rejects(client.getHeatingStatus(token), EightApiError);
});

test("PUT mutations are not retried after a server failure", async () => {
  let calls = 0;
  const client = new EightClient({
    fetch: async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    },
  });

  await assert.rejects(client.turnOff(token), EightApiError);
  assert.equal(calls, 1);
});
