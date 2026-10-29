# Costs and limits

Prices from Cloudflare's pricing pages (checked October 2026). Verify them for your account.

## What a device costs

- **One Worker request per app launch** (`GET /manifest`, one RSA signature).
- **One D1 read per check**; a **D1 write only when the device's state changed**, or at most every
  6 hours per device. An upsert writes the row and its index entries.
- **Asset downloads** only when an update is new to the device, and only for files it lacks.
  Each is a Worker request served from the edge cache or R2 (egress is free).
- **One Analytics Engine data point per check and per asset**, only if you opt in with `FLARE_OTA_ANALYTICS=on`.

## Workers Free

| | Free allowance |
|---|---|
| Worker requests | 100,000 / day, 10 ms CPU per request |
| D1 | 5 M rows read / day, 100,000 rows written / day, 5 GB |
| R2 | 10 GB-month, 1 M writes, 10 M reads / month, free egress |
| Analytics Engine | 100,000 data points / day |
| Zero Trust (Access) | up to 50 users |

Roughly a few thousand daily active devices, depending on launches per day and how often you
publish. A publish to 10,000 devices with 5 changed files is ~50,000 asset requests at once:
on Free, spread it with a rollout.

## Workers Paid ($5 / month)

| | Included | Then |
|---|---|---|
| Worker requests | 10 M / month | $0.30 / M |
| CPU | 30 M ms / month | $0.02 / M ms |
| D1 | 25 B rows read, 50 M rows written / month | $0.001 / M read, $1 / M written |
| R2 storage | 10 GB-month | $0.015 / GB-month |
| Analytics Engine | 10 M data points / month | $0.25 / M |

An app with 100,000 monthly active users launching 3 times a day makes ~9 M manifest requests a
month: inside the $5 plan.

## Limits to know

- `cf` and `cloudflare.config.ts` are in open beta; the format may change.
- The Free plan allows **one** rate-limiting rule per zone, matched on the path only: the
  `/manifest` limit then applies to every hostname of that zone.
- Asset uploads are capped at 50 MB per file; a publish at 2,000 assets per platform.
- D1 has no interactive transactions; publishing relies on batches, which are atomic.
