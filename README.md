# FPS Arena Platform

A multi-game browser platform with **play-money credits only**. Features:

- 🎯 **Shooter Arena** — 1v1 first-person shooter (Three.js, original game preserved)
- ✊ **Rock Paper Scissors** — best-of-3 PvP matchmaking via Socket.IO
- 🎡 **Roulette** — vs house, crypto-secure RNG
- 🂡 **Blackjack** — vs house, dealer hits to 17, blackjack pays 3:2
- 💳 **Wallet** — server-authoritative balance + full transaction ledger
- 🛠️ **Admin panel** — user/wallet management, audit logs

> **LEGAL NOTICE**
> Credits are fictional play-money credits only and have no real-world monetary value.
> There are no deposits, withdrawals, cash-out paths, prizes, or anything exchangeable for real value.

---

## Tech stack

- **Node.js 18+** (Express + Socket.IO)
- **PostgreSQL** (persistent users, wallets, transactions, game sessions)
- **bcrypt** password hashing
- **express-session** (cookie-based) + `connect-pg-simple` (sessions persisted in PG)
- **helmet**, **express-rate-limit**, optional **cors**
- Vanilla JS frontend (no build step)

---

## Local setup

### 1. Prerequisites

- Node 18+
- PostgreSQL 14+ (local install or Docker)

Create a database:

```bash
# Postgres CLI
createdb fps_arena
```

Or in psql:
```sql
CREATE DATABASE fps_arena;
```

### 2. Install + configure

```bash
git clone <your-repo>
cd fps-arena-platform
npm install
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, SESSION_SECRET
```

`.env.example`:

```dotenv
PORT=3000
NODE_ENV=development

DATABASE_URL=postgres://user:password@localhost:5432/fps_arena
SESSION_SECRET=change_me_please_long_random_string
JWT_SECRET=change_me_too_long_random_string

STARTING_CREDITS=1000      # given to new accounts
HOUSE_FEE_PERCENT=5        # taken from shooter pot payouts
ADMIN_USER_IDS=            # comma-separated usernames OR UUIDs
CORS_ORIGIN=               # set to your front-end origin in production
```

### 3. Run migrations

```bash
npm run migrate
```

This applies every `.sql` in `/migrations` in order (tracked by `schema_migrations`).

### 4. Start the server

```bash
npm start            # production
npm run dev          # same (no nodemon here — kept lean)
```

Open <http://localhost:3000>. You will be sent to `/login.html`. Register an account → you'll land in the dashboard.

### Creating an admin

The simplest way: put your **username** into `ADMIN_USER_IDS` *before* registering. Or, after registering, find your UUID in the users table and add it:

```sql
UPDATE users SET is_admin = TRUE WHERE username = 'me';
```

Then re-login.

---

## Deploying to Render

The repo includes `render.yaml` — a Blueprint for a free web service + free Postgres DB.

### Option A — Blueprint (one click)

1. Push this repo to GitHub.
2. In Render, click **New → Blueprint**, choose your repo.
3. Render reads `render.yaml`, provisions a free Postgres DB and a web service, generates random `SESSION_SECRET` / `JWT_SECRET`, and wires `DATABASE_URL` from the DB.
4. First build runs `npm install && npm run migrate` automatically.

### Option B — Manual

1. **Create a PostgreSQL database** in Render.
2. **Create a Web Service** from your repo:
   - Build command: `npm install && npm run migrate`
   - Start command: `npm start`
   - Health check path: `/healthz`
3. Add environment variables (see `.env.example`). Use the **Internal Database URL** for `DATABASE_URL`.
4. Deploy.

### After first deploy

To promote yourself to admin, open the Render shell:

```bash
psql "$DATABASE_URL" -c "UPDATE users SET is_admin = TRUE WHERE username = 'me';"
```

Then re-login.

---

## File structure

```
/server
  app.js                 ← Express assembly (helmet, sessions, static, API)
  server.js              ← HTTP + Socket.IO entry point
  db.js                  ← PG pool + withTx() helper
  migrate.js             ← migration runner
  auth.js                ← register / login / me
  wallet.js              ← single adjustBalance(), SELECT ... FOR UPDATE
  rng.js                 ← crypto-secure RNG helpers
  middleware/
    requireAuth.js
    requireAdmin.js
    validate.js
  games/
    shooter.js           ← live state, wallet-aware lifecycle  ← ORIGINAL shooter logic lives here
    rps.js               ← persistence + round resolution
    roulette.js          ← single-call spin (deduct + result + payout)
    blackjack.js         ← server-held deck, hit/stand
  sockets/
    index.js             ← attaches namespaces to io
    shooterSocket.js     ← /shooter namespace  ← original socket events restored verbatim
    rpsSocket.js         ← /rps namespace
  routes/
    authRoutes.js        ← /api/auth/register|login|logout|me
    walletRoutes.js      ← /api/wallet/balance|history
    gameRoutes.js        ← /api/games/roulette|blackjack
    adminRoutes.js       ← /api/admin/*

/public
  index.html             ← redirect → /login or /dashboard
  login.html, register.html
  dashboard.html         ← game hub
  wallet.html            ← balance + history
  admin.html             ← admin panel
  games/
    shooter.html         ← ORIGINAL Three.js shooter (relocated, auth-integrated)
    rps.html
    roulette.html
    blackjack.html
  css/styles.css
  js/api.js, auth.js, rps.js, roulette.js, blackjack.js
  assets/audio/
    gunshot.mp3          ← shooter SFX
    menu.wav             ← menu music

/migrations/001_init.sql ← all tables (idempotent)
render.yaml              ← Render Blueprint
package.json
.env.example
```

---

## Where the original shooter code went

| Original location                           | New location                                |
|---------------------------------------------|---------------------------------------------|
| Root `index.html` (Three.js + UI)           | `public/games/shooter.html`                 |
| Root `server.js` lobby & socket logic       | `server/sockets/shooterSocket.js`           |
| Root `server.js` weapons, hitboxes, RNG     | `server/games/shooter.js`                   |
| Root `server.js` `/audio-files` endpoint    | `server/app.js` (with audio dir moved)      |
| Root audio files (mp3/wav)                  | `public/assets/audio/`                      |

Key adaptations made (game logic itself is unchanged):

1. **Auth via session** — old in-game username prompt is gone. `shooter.html` calls `/api/auth/me` and connects to the `/shooter` Socket.IO **namespace**; the server checks `req.session.userId` in a namespace middleware.
2. **Wallet** — match start writes a `shooter_sessions` row and debits both players atomically. Match end credits the winner (or refunds both) via the central `adjustBalance()`. Disconnects forfeit to opponent.
3. **House fee** — `HOUSE_FEE_PERCENT` is taken from the pot before payout.
4. **Training mode** is untouched — bot is client-side and never touches the wallet.
5. **Audio paths** — moved from `/<file>` to `/audio/<file>`.

---

## Wallet invariants (READ THIS BEFORE TOUCHING `wallet.js`)

The wallet is the only place that mutates balance:

```js
adjustBalance(userId, amount, reason, { refType, refId, metadata, client })
```

- Always runs in a PG transaction (`withTx`) or reuses the passed client.
- Locks the wallet row with `SELECT ... FOR UPDATE`.
- Throws `insufficient_balance` if next balance < 0.
- Inserts a `wallet_transactions` row for every change (immutable ledger).
- A UNIQUE index on `(ref_type, ref_id, reason)` for `reason IN ('win','refund','bet','blackjack_payout','roulette_payout')` makes **duplicate payouts and duplicate refunds impossible** at the DB level — `adjustBalance` throws `duplicate_transaction` instead, and the call sites silently skip.
- Roulette/blackjack: bet → spin → payout all happen inside a **single** transaction → atomic.
- Shooter: bet at match start (`startShooterMatch`), payout/refund at match end (`finishShooterMatch` / `cancelShooterMatch`) — also wrapped in transactions.

---

## Security notes

| Concern                                  | Where it's handled                                                   |
|------------------------------------------|----------------------------------------------------------------------|
| Negative balance                         | `wallets.balance >= 0` CHECK + `wallet.js` next-balance guard         |
| Duplicate payout / refund                | Partial UNIQUE index on `wallet_transactions`                         |
| Concurrent transactions on same wallet   | `SELECT ... FOR UPDATE` inside `withTx`                               |
| Client lying about winning               | Server-only result calculation (roulette/blackjack/RPS/shooter)       |
| Brute-force login                        | `express-rate-limit` on `/api/auth/*`                                 |
| Session hijacking                        | `httpOnly` + `secure` (prod) cookies, `sameSite=lax`                  |
| CORS                                     | Off by default in dev; set `CORS_ORIGIN` in production                |
| Headers                                  | `helmet` (CSP disabled because the shooter uses a CDN + inline JS)    |
| Admin actions                            | `requireAdmin` middleware reads `users.is_admin`; logged in `audit_logs` |

---

## Known limitations / TODOs

- **No password reset flow.** Users with forgotten passwords need admin manual intervention.
- **No email** — by design (play-money platform, no accounts to recover).
- **Shooter socket auth** depends on `socket.request.session`. If the cookie isn't sent (e.g. opening from a different origin), connect rejects. Fine for same-origin deploys; set `CORS_ORIGIN` if you front the API on a different domain.
- **RPS matchmaking** is global by bet amount only — no skill ranking, no region filter.
- **No reconnect during a shooter match.** Disconnect forfeits to opponent. Could be relaxed with a 10s reconnect window if desired.
- **Blackjack split/double-down** not implemented (just hit/stand).
- **No webhook / payments** — and that's intentional (play-money only).
- **CSP is disabled** because the shooter loads Three.js from a CDN and uses inline scripts. If you want CSP, vendor Three.js into `/public/` and move the inline shooter JS into an external file.

---

## Manual smoke test

```bash
npm install
npm run migrate
npm start
# → http://localhost:3000

# In two browsers (or normal + incognito):
#   1. Register "alice" and "bob"
#   2. Both go to Shooter → Bronze (50 cr)
#   3. Match runs, winner gets ~95 cr (50 + 50 - 5% fee)
#   4. Check /wallet.html in each — ledger shows bet + win/loss
#   5. Try RPS, Roulette, Blackjack as well
```
