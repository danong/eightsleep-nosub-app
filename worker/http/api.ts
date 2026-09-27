import type { Env } from "../env";
import type { Settings } from "../account-state";
import { InputError, parseConnection, parseControl, parseSettings } from "./validation";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new InputError("Send JSON in the request body");
  }
  const limit = 8_192;
  const statedLength = Number(request.headers.get("content-length"));
  if (statedLength > limit) throw new InputError("Request body is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Request body is empty");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new InputError("Request body is too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError("Request body is not valid JSON");
  }
}

function checkOrigin(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new InputError("Request origin does not match this app");
  }
}

export async function handleApi(
  request: Request,
  env: Env,
  accessEmail: string,
): Promise<Response> {
  try {
    checkOrigin(request);
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName("home"));
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/api/settings") {
      return json(await scheduler.getSettings(accessEmail));
    }
    if (request.method === "GET" && path === "/api/status") {
      return json({
        ...(await scheduler.getStatus(accessEmail)),
        controlEnabled: env.CONTROL_ENABLED === "true",
      });
    }
    if (request.method === "PUT" && path === "/api/settings") {
      const settings = parseSettings(await body(request));
      await scheduler.putSettings(accessEmail, settings as Settings);
      return json({ ok: true, settings });
    }
    if (request.method === "POST" && path === "/api/control") {
      const action = parseControl(await body(request));
      const paused = action === "pause";
      await scheduler.setPaused(accessEmail, paused);
      return json({ ok: true, paused });
    }
    if (request.method === "POST" && path === "/api/connect") {
      const credentials = parseConnection(await body(request));
      await scheduler.connectAccount(accessEmail, credentials.email, credentials.password);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      return json(
        { error: error instanceof Error ? error.message : "Eight Sleep request failed" },
        502,
      );
    }
    console.error("API request failed", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Could not complete the request" }, 500);
  }
}
