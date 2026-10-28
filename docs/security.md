# Security

## What an attacker would want

1. **Ship code to your users.** Two ways in: a **publish** (or admin) token, since the server
   signs whatever is published through it; or the **signing key** plus a way to serve responses.
   Signing protects devices against anything between the server and them (storage, network, a
   spoofed host); tokens protect the publish path itself. Guard both.
2. **Change what devices get** (rollouts, rollbacks, channels): needs an **admin** token or a
   dashboard login.
3. **Exhaust your quotas or pollute metrics** with fake devices.

## Protections

**Signing key**
- Stored as a Worker secret, provided by the environment at deploy time, never written to the repo.
  The setup script generates it in memory (macOS: straight into the keychain).
- Everything the client trusts is signed: the `manifest` and `directive` parts (`rsa-v1_5-sha256`).
- `flare-ota doctor` checks the server's signature against the certificate in your app.

**API tokens**
- Three scopes: `read` ⊂ `publish` ⊂ `admin`. CI gets `publish`; agents get `read` unless you
  want them to act. Only `admin` can change rollouts, roll back, repoint channels or create tokens.
- Only the SHA-256 of a token is stored; lookups are by digest with a constant-time final compare.
- Revocable from the dashboard or CLI; `last used` is tracked.
- The CLI reads `FLARE_OTA_TOKEN` from the environment and warns when `--token` exposes it in argv;
  it refuses plain `http://` except for localhost.

**Dashboard**
- Served only on its own hostname, behind Cloudflare Access, **and** the Worker verifies the
  Access JWT itself (signature against your team's keys, audience, issuer, expiry). A request that
  reaches the Worker another way is refused. `workers.dev` is disabled.
- Actions are attributed to the verified Access email, not to a header a client could forge.
- Strict CSP, no JavaScript, same-origin check on every form post.

**Audit log**: every publish, rollout, pause, rollback, promote, channel change, preview link and
token change, with its actor.

**Inputs**
- Publish payloads are validated field by field; assets must already be uploaded.
- Uploads are content-addressed: R2 recomputes SHA-256 and rejects bytes that don't match.
- Device headers are bounded; client ids that are not UUIDs are never stored.
- Device writes are debounced and skipped when nothing changed, so check-in floods cannot turn
  into D1 write floods.

**Edge (WAF script)**: path allowlist on the updates host, bearer header required on `/api` and
`/mcp`, GET-only device routes with bounded headers, per-IP rate limit on `/manifest`. The script
merges with your zone's existing rules instead of replacing them.

**Deploy credentials**: `deploy-token` creates a Cloudflare API token limited to what a deploy
needs, unable to create other tokens.

**Preview links**: HMAC-signed, expiring (max 7 days), recorded server-side so they can be
revoked; they only select an update group, they cannot carry code.

## Your part

- Back up the signing key (password manager). Rotate it by shipping a binary with a new
  certificate.
- Keep the publish token in CI secrets; never commit `.env.*` (gitignored).
- Restrict the Access policy to the people who should operate releases.
