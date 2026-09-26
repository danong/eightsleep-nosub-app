import html from "../ui/index.html";
import css from "../ui/styles.css";
import script from "../ui/app.js.txt";
import type { Env } from "./env";
import { handleApi } from "./http/api";

export { SchedulerObject } from "./scheduler-object";

function asset(content: string, type: string): Response {
  return new Response(content, {
    headers: {
      "content-type": type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Access must authenticate the invocation itself. This fails closed if the
    // Access policy is absent or only protects some of this Worker's URLs.
    if (!ctx.access) return new Response("Cloudflare Access is required", { status: 403 });
    const identity = await ctx.access.getIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email) return new Response("Cloudflare Access email is required", { status: 403 });
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return handleApi(request, env, email);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (path === "/" || path === "/index.html") return asset(html, "text/html; charset=utf-8");
    if (path === "/styles.css") return asset(css, "text/css; charset=utf-8");
    if (path === "/app.js") return asset(script, "text/javascript; charset=utf-8");
    return new Response("Not found", { status: 404 });
  },
};
