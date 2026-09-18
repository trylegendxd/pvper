# Code review and reliability improvements

Reviewed against main commit `b4354e5`. This is a targeted code review, not a
complete security audit or a claim that the unfinished platform is ready for
real-value transactions.

## Architecture

The application has useful separation between HTTP routes, game logic, socket
handlers, and a central wallet ledger. PostgreSQL transactions and wallet row
locks are a sound foundation. Session regeneration on login, parameterized SQL,
and the existing strict avatar data-URL check are also worth preserving.

## Fixed in this change

- The global 100 KB JSON parser rejected avatar requests before the profile
  route's 300 KB parser could run. The larger parser now runs first for profile
  PATCH requests only; other endpoints retain their original limit.
- JavaScript regex coercion allowed non-string registration usernames (including
  `undefined`) through validation. Login also passed non-string passwords into
  bcrypt. Both paths now validate types before database/password operations.
- Profile fields no longer silently stringify arrays, objects, or numbers.
- Rejected database promises in the current-user and wallet read routes now
  reach Express error middleware rather than becoming unhandled rejections.
- Authentication errors no longer expose unexpected database/session messages.
  Malformed JSON and oversized bodies return stable JSON error codes.
- Logout only reports success after session destruction succeeds.
- Production refuses the development session secret and example configuration.
- The frontend API helper now merges custom headers correctly and serializes
  falsy JSON values rather than dropping them.
- Updated dependencies, including bcrypt 6, removing the old node-pre-gyp/tar
  dependency chain. The initial npm audit reported 12 vulnerabilities; the
  updated lockfile reported zero at verification time. Advisory results change.
- Added regression tests and a Node 22/24 GitHub Actions workflow.

## Remaining priorities

1. **Separate promotional/play credits from withdrawable funds before enabling
   crypto.** `server/auth.js` grants signup credits into the same wallet debited
   by `server/routes/cryptoRoutes.js` withdrawal requests. The request path does
   not distinguish their origin. Manual approval is not an accounting boundary.
   Existing play balances also need an explicit migration policy. Keep crypto
   disabled while designing and testing that separation.
2. **Enforce case-insensitive usernames at the database level.** Registration
   performs a check followed by an insert, while `001_init.sql` has only a
   case-sensitive unique constraint and a non-unique lowercase index. Concurrent
   registrations can bypass the application check. Audit existing collisions
   before introducing a unique index on `lower(username)`.
3. **Finish error handling across all routes and sockets.** Several admin, game,
   and crypto reads still have unguarded async handlers; other handlers return
   raw exception messages. Extend the tested error-handling pattern and add
   failure-path tests to those modules. Express 4 does not automatically forward
   rejected route promises.
4. **Add real PostgreSQL and multiplayer integration tests.** Verify concurrent
   bets, duplicate settlements, rollback, disconnect/reconnect, session expiry,
   and process restarts. Current wallet tests use a fake database and cannot
   prove database isolation or crash recovery.
5. **Review production boundaries.** `server/db.js` disables certificate
   verification for production PostgreSQL connections. Configure verified TLS
   for the actual provider. Validate WebSocket handshake origins explicitly;
   Socket.IO CORS settings alone are not a WebSocket-origin policy. Several game
   modules hold live state in process memory, so test restart recovery and
   deployment topology before scaling to multiple instances.

## Validation limits

Automated HTTP tests exercise the actual Express app with an in-memory session
store and mocked database operations. They cover avatar parsing, body limits,
login failures, logout success/failure, current-user and wallet failures, and
cross-origin rejection. No production database, treasury, RPC endpoint, or live
deployment was used. The game visuals and real multiplayer flows need a separate
browser/integration pass with a disposable PostgreSQL database.
