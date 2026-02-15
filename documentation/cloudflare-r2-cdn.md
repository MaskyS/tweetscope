# Cloudflare R2 CDN Setup (P0.3)

This runbook covers the `P0.3` deployment step from `deploy-file-plan.md`:
set up a public R2 bucket and upload only serving artifacts.

## 1) Create bucket and domain

1. In Cloudflare dashboard, create bucket `tweetscope-data`.
2. Enable public access.
3. Attach custom domain (example: `data.tweetscope.dev`).

## 2) Configure CORS for range reads

Use CORS rules that allow `GET`, `HEAD`, and `Range` requests. Example:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "Content-Type", "Origin", "Accept"],
    "ExposeHeaders": ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

## 3) Prepare credentials

Create an R2 API token with object read/write for the target bucket and export:

```bash
export AWS_ACCESS_KEY_ID="<r2-access-key-id>"
export AWS_SECRET_ACCESS_KEY="<r2-secret-access-key>"
export R2_ENDPOINT_URL="https://<accountid>.r2.cloudflarestorage.com"
```

## 4) Upload serving artifacts (D1 allowlist only)

Dry-run first:

```bash
python scripts/sync_cdn_r2.py \
  --data-dir "$LATENT_SCOPE_DATA" \
  --dataset visakanv-tweets \
  --scope scopes-001 \
  --bucket tweetscope-data \
  --endpoint-url "$R2_ENDPOINT_URL"
```

Execute upload:

```bash
python scripts/sync_cdn_r2.py \
  --data-dir "$LATENT_SCOPE_DATA" \
  --dataset visakanv-tweets \
  --scope scopes-001 \
  --bucket tweetscope-data \
  --endpoint-url "$R2_ENDPOINT_URL" \
  --execute
```

The script uploads:
- `meta.json`
- `scopes/<scope>.json`
- `scopes/<scope>-input.parquet`
- active cluster-label artifacts referenced by that scope (`clusters/<label-id>.json|parquet`)
- `links/meta.json`
- `links/edges.parquet`
- `links/node_link_stats.parquet`

## 5) Wire API to CDN

Set API env var:

```bash
DATA_URL=https://data.tweetscope.dev
```

For demo scope changes, also verify:

```bash
LATENT_SCOPE_PUBLIC_SCOPE=<current-scope-id>
```
