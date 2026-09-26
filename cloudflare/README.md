# Cloudflare mattress controller

The Cloudflare Worker serves the private UI and API. Cloudflare Access supplies the signed-in user's email, and one Durable Object named `home` stores both users' settings and Eight Sleep connections. The object owns scheduling and uses a single alarm for the next scheduled control change. The Worker stays at the Access boundary and forwards validated requests to the object.

The current schedule preheats one hour before bedtime, uses the early setting through the first hour after bedtime, then the middle setting until two hours before wake, then the late setting until wake. It turns heating off at wake. A physical or app adjustment during sleep is respected until wake; a daytime manual change after shutoff is respected until the next preheat. The scheduler should depend on schedule transitions rather than these display labels, so the phase model can evolve independently.

## Local development

From this folder, run `npm ci` and `npm test`. Node 24 or later is recommended for the TypeScript tests. Create `.dev.vars` with a development-only, 64-character hex `TOKEN_KEY` (for example, `openssl rand -hex 32`). Wrangler's simulated Access identity is `local@example.invalid`. Run `npm run dev` and open `http://localhost:8787`.

Local Durable Object data is stored by Wrangler. `CONTROL_ENABLED` defaults to `false`, so settings and connections can be tested without schedule actions changing the bed. Unit tests mock Eight Sleep. Enable control only when no other scheduler controls the bed.

## Cloudflare setup

1. Add `TOKEN_KEY` as a Worker secret. Generate a fresh 64-character hex value with `openssl rand -hex 32`, then use `npx wrangler secret put TOKEN_KEY` or the Cloudflare dashboard. The key encrypts Eight Sleep tokens stored in the Durable Object. Keep a secure backup; losing or changing it requires each person to reconnect.
2. Deploy with `npm run deploy` while `CONTROL_ENABLED` remains `false`. Wrangler creates the SQLite-backed Durable Object storage from the migration in `wrangler.jsonc`. Protect the entire Worker, including `workers.dev` and preview URLs, with Cloudflare Access. Allow only the two intended email addresses. The Worker also rejects requests without an Access identity.
3. Attach `sleep.danong.dev` as a Worker Custom Domain. Verify Access login, the settings UI, and that an unauthenticated request cannot use the API.
4. Enter each person's schedule and connect their Eight Sleep account in the UI. This starts the Cloudflare installation from scratch; the development D1 data is not migrated. The password is sent to Eight Sleep for login and is not stored. Resulting tokens are encrypted in Durable Object storage.

## Cutover and rollback

Keep the Vercel deployment available for rollback, but do not run both schedulers against the same bed. Connecting an account confirms login, device status, and encrypted token storage; it does not exercise the schedule.

1. Save both schedules and confirm the time zone, bedtime, wake time, and temperature levels. With `CONTROL_ENABLED` false, the UI shows preview mode and the scheduler does not change the bed.
2. At cutover, disable the `cron-job.org` job that calls Vercel's `/api/temperatureCron`. Confirm it is disabled before enabling Worker control.
3. Set `CONTROL_ENABLED` to `true` in `wrangler.jsonc` and redeploy. Keep the Vercel cron disabled.
4. Over the next several nights, check Cloudflare Worker logs and the UI's last-run time and errors. Confirm the Eight Sleep app or physical controls reflect the schedule. Durable Object alarms run at scheduled boundaries, rather than polling every 30 minutes.
5. If a run fails or the bed does not follow the schedule, set `CONTROL_ENABLED` to `false` and redeploy before re-enabling the Vercel cron. Never leave both schedulers active for the same bed.

The Vercel app retains its own Postgres data and credentials. Check that its Eight Sleep connection still works before relying on it for rollback, since a fresh login may affect existing tokens.

## Code map

- `worker/schedule/`: schedule and manual override calculations.
- `worker/eight/`: Eight Sleep HTTP client.
- `worker/scheduler-object.ts` and `worker/account-state.ts`: alarm-driven scheduling and SQLite-backed user state.
- `worker/http/`: Access-protected JSON API and input validation.
- `ui/`: mobile settings page served by the Worker.

The UI files are served by the Worker rather than a Static Assets binding because Cloudflare does not pass Access identity into Worker code behind its Static Assets router. The API uses `ctx.access` to select the signed-in person's settings.
