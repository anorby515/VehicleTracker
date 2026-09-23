# Push Worker

A small Cloudflare Worker that delivers the app's Web Push notifications. The App API (Apps Script) decides what to send and to whom, but Apps Script can't do the ES256 signing Web Push needs. So the API POSTs each batch here, and for every message the Worker:

1. signs a VAPID JWT for the push service ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292));
2. encrypts the payload for the subscription ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), `aes128gcm`);
3. POSTs it to the phone's push service and reports the result.

It has no npm dependencies, only WebCrypto. The code is `src/index.js` (routing, auth, delivery) and `src/webpush.js` (crypto and payload helpers).

## Contract

The Worker is server-to-server only. It sends no CORS headers, and **any request with an `Origin` header gets `403`**, so a browser can't call it.

### `GET /`

A health check: `200 {"ok":true,"service":"vehicles-push"}`.

### `POST /send`

Headers: `Authorization: Bearer <PUSH_SECRET>`. The body is JSON:

```json
{
  "messages": [
    {
      "id": "due:2023 Toyota 4Runner:Tire rotation:2026-10-07",
      "subscription": {
        "endpoint": "https://web.push.apple.com/QExampleToken",
        "keys": { "p256dh": "<base64url>", "auth": "<base64url>" }
      },
      "payload": { "title": "4Runner", "body": "Tire rotation due in 2 weeks", "url": "https://example.github.io/VehicleTracker/#/v/2023%20Toyota%204Runner", "tag": "due-4runner" },
      "ttl": 86400,
      "urgency": "normal"
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `messages` | Array of 0–50 messages. The limit matches the free plan's 50 outgoing requests per call. |
| `id` | Any value. It is echoed back in the result so the caller can match it. |
| `subscription` | What `PushSubscription.toJSON()` returns. The endpoint must be `https` on a known push service (see below). |
| `payload` | `{title, body, url, tag}`, the `PushPayload` type in `web/src/api/types.ts`. `title` is required. `url` is required and must be an **absolute `https:` URL** without credentials (iOS parses `navigate` with no base URL, so a relative one like `#/v/X7` would be lost); anything else is refused with `bad_url` and nothing is sent. Other fields are dropped. The Worker sends it as a Declarative Web Push message (below). If that JSON is over 3,000 bytes, `body` is shortened with "…" (and then `title`, if it still doesn't fit). |
| `ttl` | Seconds the push service keeps the message for an offline phone. Default 86,400; clamped to 1–2,419,200 (28 days). Never 0: Apple rejects a TTL that isn't a positive number (`BadTtl`). |
| `urgency` | `very-low`, `low`, `normal` or `high`. Anything else means `normal`. |

**What the phone receives** is the payload wrapped as [Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/) (`docs/API.md` › Push):

```json
{"web_push":8030,"notification":{"title":"4Runner","body":"Tire rotation due in 2 weeks","navigate":"<url>","tag":"due-4runner","data":{"url":"<url>"}}}
```

iOS 18.4+ shows it without running the service worker and opens `navigate` on tap. Older iOS versions pass the same JSON to the service worker's `push` handler.

The response is `200` with one result per message, in the same order:

```json
{ "results": [
  { "id": "…", "status": 201, "ok": true, "gone": false },
  { "id": "…", "status": 403, "ok": false, "gone": false, "error": "{\"reason\":\"BadJwtToken\"}", "reason": "BadJwtToken" }
] }
```

| Field | Meaning |
| --- | --- |
| `status` | The push service's HTTP status. It is `0` when the Worker didn't send the message. |
| `ok` | `true` for any 2xx (Apple and Google answer `201`). |
| `gone` | `true` for `404` or `410`: the subscription has expired. The API sets that Push Subscriptions row to Active = No. |
| `error` | Only present when `ok` is false. For `status: 0` it is one of `endpoint_not_allowed`, `bad_subscription` (keys missing or invalid), `bad_payload` (no title, or it can't fit), `bad_url` (`payload.url` isn't an absolute `https:` URL), `bad_message`, `vapid_failed` (signing failed; shouldn't happen once the keys import), `network` or `timeout` (10 s). Otherwise it is the push service's response text, up to 200 characters, for example Apple's `{"reason":"BadJwtToken"}`, or `http_<status>` if there was no text. Redirects are never followed, so a `3xx` is reported as a failure. |
| `reason` | Only present when `ok` is false. The `reason` string from the push service's JSON error body (Apple: `BadJwtToken`, `BadAuthorizationHeader`, `BadVapidPublicKey`, `VapidPkHashMismatch`, `BadTtl`, `PayloadTooLarge`, …), or `null` when there is none (including every `status: 0` result). The API keeps the subscription for the three VAPID configuration reasons and only deactivates it on `gone`. |

One bad message never fails the batch. Errors for the whole request:

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized` | The bearer token is missing or wrong. It is compared in constant time. |
| 403 | `forbidden` | The request has an `Origin` header. |
| 400 | `bad_json`, `bad_request`, `too_many_messages` | The body isn't JSON, `messages` isn't an array, or there are more than 50 messages. |
| 413 | `too_large` | The body is over 256 KB. |
| 500 | `not_configured` | `PUSH_SECRET` is unset (every send is refused), or the VAPID settings are missing or invalid. `detail` says which one. VAPID problems are only reported to a caller with the right secret. |
| 404 | `not_found` | Any other method or path. |

**Allowed push services:** `web.push.apple.com` and `*.push.apple.com` (iPhone), `fcm.googleapis.com` (Chrome and Android), `updates.push.services.mozilla.com` (Firefox), and `*.notify.windows.com` (Edge). Any other host, `http:`, a non-default port or credentials in the URL gives `endpoint_not_allowed`. The Worker doesn't follow redirects either. That way it can't be used as an open relay even if the secret leaks.

### Calling it from Apps Script

```js
const res = UrlFetchApp.fetch(workerUrl + '/send', {
  method: 'post',
  contentType: 'application/json',
  headers: { Authorization: 'Bearer ' + secret },   // Script Property PUSH_WORKER_SECRET
  payload: JSON.stringify({ messages: messages }),
  muteHttpExceptions: true,
});
const results = JSON.parse(res.getContentText()).results;
```

`UrlFetchApp` doesn't send an `Origin` header, so the Worker accepts it.

## Configuration

| Name | Kind | Value |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | var (`wrangler.toml`) | base64url 65-byte uncompressed P-256 point. The same value goes in `vapidPublicKey` in `web/app.config.json`. It is public. |
| `VAPID_SUBJECT` | var (`wrangler.toml`) | A contact for the push services. It must start with `mailto:` or `https:`. The default is the app's public URL, so no email address is in the repo. |
| `VAPID_PRIVATE_KEY` | **secret** | base64url 32-byte private key. |
| `PUSH_SECRET` | **secret** | A long random string. Apps Script's `PUSH_WORKER_SECRET` Script Property holds the same value. |

Set the secrets with `npx wrangler secret put VAPID_PRIVATE_KEY` and `npx wrangler secret put PUSH_SECRET`, or in the dashboard (Worker → Settings → Variables and Secrets, type *Secret*). They never go in the repo.

**VAPID keys:** `npx web-push generate-vapid-keys` prints a *Public Key* and a *Private Key*. Both are already base64url, in exactly the form used here. Generate them once. If you change them, every phone has to turn notifications off and on again, because subscriptions are tied to the public key.

**Push secret:** for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Deploying

There are two ways to deploy. `SETUP.md` has Andrew's step-by-step version.

- **Wrangler:** put the public key in `wrangler.toml`, then run `npx wrangler deploy` from `push-worker/`.
- **Dashboard paste:** run `npm run bundle`. This needs Node 22 and nothing to install. It writes `dist/worker.js`, a single ES module file made from `src/`. Paste that file into the Worker's editor, then set the two vars and two secrets in Settings. `dist/` is git-ignored, so rebuild it after any change to `src/`.

Check a deployment by opening the Worker URL in a browser. `GET /` should return `{"ok":true,"service":"vehicles-push"}`.

**If every send fails with `403`**, the push service rejected the VAPID JWT (Apple returns `BadJwtToken`). Check the following:

- `VAPID_PRIVATE_KEY` matches `VAPID_PUBLIC_KEY`;
- `VAPID_SUBJECT` starts with `mailto:` or `https:`;
- the phones subscribed with the same public key.

## Tests

```sh
npm test        # node --test, Node 22, no install
```

The tests cover the following:

- the RFC 8291 section 5 example vector, using a fixed salt and sender key;
- round-trip decryption, with an independent `node:crypto` decryptor and freshly generated receiver keys;
- the VAPID JWT's claims and its signature, checked against the public key;
- auth, Origin rejection, the endpoint allowlist, and 404/410 → `gone`, using a stubbed `fetch`;
- the parsed `reason` next to the raw error text, the TTL floor of 1 second, and `bad_url` for anything but an absolute `https:` URL;
- the Declarative Web Push wrapper and payload truncation;
- the dashboard bundle, loaded and run end to end.
