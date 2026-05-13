# sui-onramp-api

Backend proxy for fiat-onramp flows on Sui mobile wallets. Wraps Alchemy
Pay's merchant API so client apps never have to hold the merchant
`appSecret` — credentials live only in this service's env vars, and the
client calls a small set of normalized endpoints (`/buy/crypto-list`,
`/buy/fiat-list`, `/buy/quote`, `/buy/order`).

## Stack

- Node 22 (uses `--experimental-strip-types` to run TypeScript directly, no separate build step)
- pnpm 9 (managed via Corepack — version pinned by `package.json#packageManager`)
- Express 4
- Zod for env + request validation

All dependency versions in `package.json` are **pinned exactly** (no caret ranges) and locked in `pnpm-lock.yaml`. `.npmrc` sets `frozen-lockfile=true` so installs fail loudly on lockfile drift instead of silently picking up newer versions.

## Setup

```bash
cd sui-onramp-api
nvm use                  # picks Node 22 from .nvmrc
corepack enable          # makes pnpm available at the version package.json pins
pnpm install             # frozen-lockfile install
cp .env.example .env
# fill in ALCHEMY_PAY_APP_ID and ALCHEMY_PAY_APP_SECRET in .env
pnpm dev                 # tsx watch on :8080
```

Smoke test the proxy:

```bash
curl 'http://localhost:8080/buy/crypto-list?fiat=USD' | jq
curl -X POST 'http://localhost:8080/buy/quote' \
  -H 'content-type: application/json' \
  -d '{"crypto":"USDC","network":"SUI","fiat":"USD","fiatAmount":"100"}' | jq
```

## Endpoints (v1)

| Method | Path               | Purpose                                                                    |
| ------ | ------------------ | -------------------------------------------------------------------------- |
| `GET`  | `/healthz`         | Liveness check (no external dependencies).                                 |
| `GET`  | `/buy/crypto-list` | Sui-mainnet coins the configured providers support buying right now.       |
| `GET`  | `/buy/fiat-list`   | Fiat currencies + per-method limits/fees the providers support.            |
| `POST` | `/buy/quote`       | Live rate + per-crypto-per-method floor/ceiling for a `(crypto, fiat)`.    |
| `POST` | `/buy/order`       | Signed hosted-checkout URL the client opens in an in-app browser.          |

Planned next: `POST /buy/webhook` (Alchemy delivery receipt → order status persistence).

## Deployment

Any Node 22 host works. Two common choices:

- **Render (free tier)** — connect the repo, build with `corepack enable && pnpm install --frozen-lockfile --prod=false`, start with `node --experimental-strip-types src/index.ts`. Set env vars in the dashboard. Free instance sleeps after 15 min of idle; ~30s cold start on first hit.
- **AWS App Runner / Cloud Run** — the provided `Dockerfile` is App Runner / Cloud Run-compatible. Point it at the repo, set the env vars, deploys on push.

Don't set `PORT` manually on hosted platforms — they inject it; `src/config.ts` reads it from `process.env`.

## Security

- `ALCHEMY_PAY_APP_SECRET` **must never** be bundled into a client app or
  committed to git. It lives only in this service's deployment env.
- All Alchemy requests are HMAC-SHA256 (base64) signed in
  [`src/lib/alchemy.ts`](src/lib/alchemy.ts) — verify the canonicalization
  rule against your Alchemy Pay merchant docs since it has shifted between
  API versions.
- Add an auth header (e.g. session token or API key) before exposing this
  service publicly. Until then, treat the endpoints as internal.
