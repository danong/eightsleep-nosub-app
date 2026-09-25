# Cloudflare mattress controller

This is the replacement for the Vercel app. It lives in this folder so the existing deployment keeps working during migration. One Worker serves the private UI and runs the schedule; D1 stores each Access user's Eight Sleep connection, schedule, and override state. The Worker uses Eight Sleep's cloud API and still needs an internet-connected hub.

The schedule checks every 30 minutes, matching the current cron setup. A stage change or wake shutoff can therefore happen up to 30 minutes after its configured time. It preheats one hour before bedtime, uses the early setting through the first hour after bedtime, then the middle setting until two hours before wake, then the late setting until wake. It turns the side off at wake. A physical or app adjustment during sleep is respected until wake. A daytime manual change after the scheduled off is respected until the next preheat.

## Local development

From this folder, run `npm ci` and `npm test`. Node 24 or later is recommended for the TypeScript tests. The local Worker uses a local D1 database and a simulated Cloudflare Access identity (`local@example.invalid`) from `wrangler.jsonc`.

Create `.dev.vars` with a development-only, 64-character hex `TOKEN_KEY`. For example, use `openssl rand -hex 32` to make the value. This file and local D1 state are ignored by Git. Then run `npm run db:local` and `npm run dev`. Wrangler serves the app at `http://localhost:8787`. The local cron handler can be invoked at `http://localhost:8787/cdn-cgi/local/scheduled?format=json`.

`CONTROL_ENABLED` defaults to `false`, so cron returns without contacting Eight Sleep or changing the bed. Unit tests mock the Eight Sleep API. Local development with a real account requires deliberately enabling control; do that only when no other scheduler controls that side.

## Cloudflare setup

1. In the same Cloudflare account as `danong.dev`, create a D1 database named `eight-sleep`. Replace the zero UUID in `wrangler.jsonc` with its database ID. Apply the checked-in migration with `npm run db:remote` from this folder. Review the command's `--remote` target before confirming.
2. Add `TOKEN_KEY` as a Worker secret. Generate a fresh 64-character hex value with `openssl rand -hex 32`, then enter it via `npx wrangler secret put TOKEN_KEY` or the Cloudflare dashboard. This key encrypts rotating Eight Sleep tokens in D1. Keep a secure backup; losing or changing it requires each person to reconnect their account.
3. Deploy with `npm run deploy` while `CONTROL_ENABLED` remains `false`. The configured cron trigger is safe in this mode. Protect **the entire Worker**, including its `workers.dev` and preview URLs, with Cloudflare Access. Allow only your and your partner's specific email addresses. The Worker also rejects HTTP requests that lack Access identity.
4. Attach `sleep.danong.dev` as a Worker Custom Domain. Cloudflare creates its DNS record and certificate. The public `danong.dev` website is a separate deployment. Verify Access login, the dark settings UI, D1 persistence, and that an unauthenticated request cannot use the API.
5. Re-enter each person's schedule in the private UI. Connect the Eight Sleep accounts during cutover, after stopping the old cron job, because a fresh login may affect existing tokens. The password is sent to Eight Sleep for login and is not stored; the resulting tokens are stored encrypted in D1. The old Postgres profiles are not copied automatically.

Cloudflare's free Worker limit is 10 ms of CPU per invocation; time waiting on `fetch()` or D1 is excluded. Before relying on this in production, check Cron event logs for CPU limit errors during real two-account runs. The schedule logic is intentionally small to fit that limit.

## Cutover and rollback

Keep the existing Vercel deployment available until the new app has worked through several nights. To cut over, first disable the `cron-job.org` job that calls Vercel's `/api/temperatureCron`. Confirm it has stopped, then connect both Eight Sleep accounts in the private Cloudflare UI. Set `CONTROL_ENABLED` to `true` in `wrangler.jsonc` and redeploy. Observe the next Cloudflare cron event and the bed's actual state. Never leave both schedulers active for the same side.

For rollback, first set `CONTROL_ENABLED` back to `false` and redeploy (or disable the Worker Cron Trigger in Cloudflare). Confirm Worker commands have stopped. Only then re-enable the old `cron-job.org` job. The old Vercel app retains its own Postgres data and credentials. Check that its Eight Sleep connection still works, since a fresh login in the new app may affect existing tokens.

## Code map

- `worker/schedule/`: pure schedule and override decisions, with tests.
- `worker/eight/`: Eight Sleep HTTP client, with mocked API tests.
- `worker/store.ts` and `worker/secrets.ts`: D1 persistence and token encryption.
- `worker/run.ts`: the scheduled account loop.
- `worker/http/`: Access-protected JSON API and input validation.
- `ui/`: dark mobile settings page, served through the Worker.
- `migrations/`: D1 schema changes.

The UI files are served by the Worker rather than a Static Assets binding because Cloudflare does not currently pass Access identity into Worker code behind its Static Assets router. The API uses `ctx.access` to select the signed-in person's account.
