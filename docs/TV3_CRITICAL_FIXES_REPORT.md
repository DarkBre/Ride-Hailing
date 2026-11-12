# TV3 CRITICAL FIXES REPORT

**Branch:** `feature/tv3-critical-fixes`  
**Base:** `feature/tv3-payment-gateway-clean` (`c982ad8`)  
**Code commit:** `c4b5019`  
**Scope:** TV3 only — Payment, API Gateway, Notification, Dashboard, RabbitMQ topology, Outbox, tracing, deployment.

---

## 1. Bugs fixed

### Payment state machine
- `payment-logic.js` now treats `CAPTURED` and `FAILED` as terminal; duplicate holds cannot re-debit.
- `REFUNDED` remains terminal and aborts a delayed hold.
- Duplicate `HELD` requests do not debit again and re-create `payment.event.hold_success` when the outbox event is missing/failed.
- Capture-before-hold now inserts into `pending_captures`; the hold transaction reconciles the pending capture atomically. Refund/capture/terminal paths clean the pending row.
- Wallet updates during hold/capture/refund check `rowCount === 1`; zero-row updates throw and roll back.
- Added `pending_captures` to `schema.sql`.

### Transactional Outbox
- `PaymentBroker.publish()` registers `channel.on('return')`, uses unique message IDs, waits for publisher confirmation, and rejects `basic.return` (unroutable) messages.
- `OutboxWorker` no longer marks PUBLISHED until `broker.publish()` succeeds with routing.
- Removed the unsafe PENDING fallback that published unclaimed rows.
- Claim query remains `FOR UPDATE SKIP LOCKED` + fencing token; two workers cannot publish the same row.
- Added `next_attempt_at` and `last_error` columns, bounded exponential backoff, per-event malformed-payload isolation, and `requeueFailed()` recovery.
- FAILED events remain in the outbox and can be requeued.

### Broker lifecycle
- Payment legacy `unbindQueue` calls moved to a throwaway channel so a missing binding cannot kill the main consumer channel.
- Payment and Notification reconnect on connection and channel close with bounded exponential backoff.
- Consumers are recreated after reconnection.
- Notification handlers capture their own channel, so old in-flight messages cannot ACK/NACK through a new channel.
- Partially initialized connections/channels are closed on connect failure.
- ACK/NACK calls are guarded against closed channels.

### Authentication and secrets
- Payment, Notification, and Gateway configs fail closed in `NODE_ENV=production` when JWT/INTERNAL/driver keys are missing or equal known development defaults.
- Development mode remains usable with explicit fallback secrets.
- Payment no longer falls back to local JWT verification when Identity returns 401/403; fallback is only for genuine Identity unavailability (network/5xx).
- Compose no longer injects every internal key into every service; keys are scoped per service.
- Payment and Notification send `X-Internal-Key` when broadcasting to Gateway.

### Notification and Gateway security
- Gateway protects:
  - `GET /api/v1/notifications` with JWT/internal key.
  - `GET /api/v1/simulation/stream` with JWT (query token supported for EventSource) or internal key.
  - `POST /api/v1/simulation/broadcast` with internal key only.
- Notification retrieval requires JWT/internal key and filters by authenticated `user_id`; cross-user queries are rejected.
- Gateway SSE filters notification/payment payloads by authenticated user; internal clients observe all.
- Dashboard connects SSE with the current passenger JWT and reconnects when the selected passenger changes.
- Notification dedup cache is bounded in memory.

### Compose / readiness
- All business-service healthchecks now use `/ready` instead of `/live`.
- Matching waits for Driver healthy; Notification waits for Gateway healthy.
- Payment/Notification/Gateway get explicit `NODE_ENV` and required secrets.
- Added `.dockerignore` files for Payment, Notification, Gateway, and Dashboard.
- Seed script uses configured `POSTGRES_USER` instead of hardcoding `postgres`.

---

## 2. Files modified / added

**Modified**
- `src/payment-service/payment-logic.js`
- `src/payment-service/schema.sql`
- `src/payment-service/broker.js`
- `src/payment-service/outbox.js`
- `src/payment-service/auth.js`
- `src/payment-service/config.js`
- `src/payment-service/index.js`
- `src/api-gateway/index.js`
- `src/api-gateway/config.js`
- `src/notification-service/index.js`
- `src/notification-service/notification-logic.js`
- `src/web-dashboard/public/app.js`
- `deploy/docker-compose.yml`
- `scripts/seed-demo.js`
- `tests/*` existing suites updated for development test env and new auth.

**Added**
- `src/api-gateway/auth.js`
- `src/notification-service/auth.js`
- `src/notification-service/config.js`
- `src/{payment,notification,api-gateway,web-dashboard}/.dockerignore`
- `tests/payment-state-machine.test.js`
- `tests/outbox-reliability.test.js`
- `tests/broker-lifecycle.test.js`
- `tests/payment-config.test.js`
- `tests/test-env.js`
- `docs/TV3_CRITICAL_FIXES_REPORT.md`

---

## 3. Regression tests and results

Command:

```bash
node tests/run-all-tv3.js
```

Result: **75/75 tests PASS** across 11 files:

| File | Result |
|---|---|
| `ft-07-payment.test.js` | 7/7 |
| `payment-state-machine.test.js` | 7/7 |
| `outbox-reliability.test.js` | 11/11 |
| `broker-lifecycle.test.js` | 4/4 |
| `payment-auth.test.js` | 6/6 |
| `payment-config.test.js` | 4/4 |
| `fr-01-fr-02-fault-saga.test.js` | 7/7 |
| `dlq-retry.test.js` | 5/5 |
| `notification.test.js` | 6/6 |
| `topology.test.js` | 5/5 |
| `gateway.test.js` | 13/13 |

Additional checks:

```bash
node scripts/check.js
node --check <modified JS files>
node -e "JSON.parse(...deploy/rabbitmq-definitions.json...)"
```

All passed. Compose YAML was parsed with a YAML parser including merge-key support; 10 services and readiness checks were verified structurally.

### Test classification
- **Unit:** Payment state machine, auth/JWT, config production validation, outbox worker (mock DB), notification logic/dedup.
- **Mocked integration:** outbox broker publish/return/confirm, fake AMQP reconnect, gateway mock upstreams, notification fake AMQP.
- **In-process real HTTP:** Payment 401/403, Notification `/live` `/ready` `/notifications`, Gateway auth/SSE/broadcast.
- **Real PostgreSQL/RabbitMQ tests:** **NOT RUN**.
- **Docker E2E tests:** **NOT RUN**.

---

## 4. Docker limitation

This machine has no Docker CLI/Engine (`docker --version` → command not found). Therefore:

- `docker compose config`, `docker compose up`, container health, real PostgreSQL migrations, real RabbitMQ queues/DLQ/retry and E2E saga were **not executed**.
- Compose was validated by parsing YAML and inspecting service/env/healthcheck structure only.
- The passing suite proves unit/mock/in-process behavior, not container-level behavior.

---

## 5. Remaining known issues

1. Notification deduplication is bounded in memory but **not durable across process restart**.
2. Payment local JWT fallback when Identity is unreachable cannot check the logout blacklist; this is a documented trade-off.
3. Gateway and Notification verify JWT locally and do not query Identity’s blacklist.
4. Outbox `FAILED` events require operator action via `requeueFailed()`; there is no automatic replay after a long outage beyond the configured retry sequence.
5. `scripts/seed-demo.js` still writes the Driver profile directly to `driver_db` because TV2 has no profile-creation API.
6. Full Compose integration still requires `--profile full` and the TV1/TV2 service directories.

---

## 6. TV1/TV2 integration dependencies

TV3 did not modify TV1/TV2. Before real E2E:

1. Merge the exact TV1/Identity/Trip and TV2/Driver/Matching commits. The SSOT references `ab90ebd` for TV1, but that commit lacks the RabbitMQ `broker.js`/`driver-client.js`/`amqplib` wiring expected by the Compose environment; confirm the actual integration commit.
2. Keep `JWT_SECRET`, `INTERNAL_KEY`, `DRIVER_INTERNAL_KEY`, and `DRIVER_TRIP_KEY` identical across TV1/TV2/TV3.
3. Run `docker compose --profile full up -d --build --wait`, then `node scripts/seed-demo.js`.
4. Exercise hold → capture → refund, capture-before-hold, duplicate hold, broker restart and DLQ on real PostgreSQL/RabbitMQ.
