# Nightshift

A WebApp that allows users to schedule an Eight Sleep Pod without an Eight Sleep subscription.

<img src="nightshift.png" alt="Nightshift Screenshot">

Each user chooses a bedtime, wake time, time zone, and early, middle, and late levels. The app derives the phase times and starts preheat up to one hour before bedtime. Physical or Eight Sleep app adjustments during sleep are respected until wake; daytime adjustments persist until the next preheat. The UI shows recent scheduler checks, observed bed settings, and commands. These observations come from scheduled runs; the app does not poll the bed.

This runs on Cloudflare's free tier. Cloudflare Access identifies each user. One SQLite-backed Durable Object stores both users' settings and encrypted Eight Sleep tokens, and its alarm wakes at the next schedule change. The Worker serves the UI and API from this repository.

## Acknowledgment

Nightshift was inspired by [aerotow's Eight Sleep Control App](https://github.com/aerotow/eightsleep-nosub-app). Thanks to aerotow for showing how to schedule an Eight Sleep Pod without a subscription.

The original app uses a recurring 30-minute job with Vercel, Postgres, and cron-job.org. Nightshift uses one Cloudflare Worker and a SQLite-backed Durable Object whose alarm runs at the next schedule change. It respects manual temperature changes until wake or the next preheat, and the Deploy to Cloudflare flow removes the separate database and cron service setup.

## Develop

Use Node 24 or later. Run `npm ci`, `npm test`, and `npm run typecheck` from the repository root. For local development, create `.dev.vars` with a **development-only** 64-character hex `TOKEN_KEY` (for example, `openssl rand -hex 32`), then run `npm run dev` and open `http://localhost:8787`. Wrangler supplies the local Access identity `local@example.invalid`. The dev script forces `CONTROL_ENABLED=false`, so local alarms do not control the bed.

Wrangler stores local Durable Object data in `.wrangler/`. Both `.dev.vars` and `.wrangler/` are ignored by Git.

## Deploy

You need GitHub and Cloudflare accounts. These steps use only your browser:

1. Open the [token key generator](https://sleep-demo.danong.dev/token-key.html). Copy the 64-character key and keep a private backup. The page generates it in your browser and sends it nowhere. This key encrypts stored Eight Sleep tokens; changing or losing it requires each user to reconnect.
2. Click [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/danong/eightsleep-nosub-app) and sign in to GitHub and Cloudflare when prompted. Cloudflare copies the repository into your GitHub account and provisions the Durable Object. On the setup screen, paste the key into the `TOKEN_KEY` secret field.
3. Choose a Worker name, then deploy. Cloudflare gives it a `https://<worker-name>.<your-subdomain>.workers.dev` URL. The app requires Cloudflare Access, so it will return 403 until you finish the next step.
4. In Cloudflare, open **Workers & Pages → your Worker → Access → Protect this Worker behind Access**. Choose **All traffic** (including production and previews). Configure an **Allow** policy that includes only the specific email addresses allowed to control the bed, then select **Apply Access**. Use a sign-in method available to those addresses. [Worker-level Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) protects the Worker across its `workers.dev` URL, custom domains, and previews; a hostname-only policy does not cover every URL.
5. Open the `workers.dev` URL from step 3 and sign in through Access. The Nightshift settings page should load under your email address.
6. Connect your Eight Sleep account, choose a bedtime, wake time, time zone, and temperature levels, then save the schedule. The deployed Worker has bed control enabled.

Optional: You can add a custom domain after Access is in place. For Workers Git builds, use this repository root, leave the build command empty, set the deploy command to `npx wrangler deploy`, and set the preview command to `npx wrangler preview`. Previews have separate Durable Object storage and `CONTROL_ENABLED=false`; they need a `TOKEN_KEY` secret and Access to sign in. This repository's existing `eight-sleep-control` Worker can still be updated with `npm run deploy`; its `SchedulerObject` binding and remote data stay in place. Before updating it, confirm Worker-level Access covers **All traffic**, since `workers_dev=true` enables a new URL. To stop bed control, set `CONTROL_ENABLED` to `false` in `wrangler.jsonc` and deploy again.

## Code map

- `worker/index.ts`: Access gate and UI asset routes.
- `worker/http/`: JSON API and input validation.
- `worker/scheduler-object.ts`: account state, alarms, and Eight Sleep reconciliation.
- `worker/schedule/`: phase and manual override calculations.
- `worker/eight/`: Eight Sleep HTTP client.
- `ui/`: mobile settings page, schedule chart, and recent activity.
- `scripts/build-demo.mjs`: static Pages output built from `ui/`.

The private UI assets are served through the Worker so every private request passes the Access identity check. The public demo is a separate static Pages site.
