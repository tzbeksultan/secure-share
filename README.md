# Secure Share

A self-hostable, privacy-first MVP for sharing text and files through expiring, one-time links.

> **Security status: experimental.** This project has not been independently audited. Do not use it for bank credentials, customer data, production secrets, or regulated information until it has undergone a security review and deployment hardening.

## MVP features

- Browser-side AES-256-GCM encryption using the Web Crypto API.
- Encryption key stays in the URL fragment (`#key=...`) and is never sent in HTTP requests.
- One-time retrieval: the server atomically consumes a share on its first successful read.
- Server-side TTL (5 minutes, 1 hour, or 24 hours).
- Text and file sharing (10 MiB maximum).
- No account required; opaque random share IDs.
- In-memory backend storage; shares are lost when the server restarts.
- Responsive React interface.

## Important limitations

- A recipient can still photograph the screen with another device. Web apps cannot reliably prevent screenshots across browsers and operating systems.
- This MVP does not provide PIN protection, identity verification, recipient binding, persistent encrypted storage, malware scanning, abuse prevention, or audited cryptographic design.
- One-time links are bearer links: anyone who gets the complete URL can open them first.
- The browser must be served over HTTPS in production. The API must also be protected by HTTPS.
- The backend stores ciphertext, but metadata (share ID, expiry, size) is visible to the server.

## Run locally

Requirements: Go 1.22+, Node.js 20+.

### Backend

```bash
cd backend
go run .
```

The API listens on `http://localhost:8080` by default. Set `PORT` to change it. The UI limits original files to 10 MiB; the API allows 16 MiB of decoded encrypted payload to account for base64 and JSON overhead.

### Frontend

In a second terminal:

```bash
npm install
npm run dev
```

Vite proxies `/api` to the backend. Open the URL printed by Vite.

## Configuration

- `PORT`: backend listen port (default `8080`).
- `MAX_UPLOAD_BYTES`: maximum encrypted payload size in bytes (default `10485760`).
- `ALLOWED_ORIGIN`: allowed browser origin for CORS (default `http://localhost:5173`). Set this to your exact HTTPS frontend origin in deployment.

## API

- `GET /api/health` — health check.
- `POST /api/shares` — create encrypted share. JSON body: `{ "ciphertext": "<base64>", "expiresInSeconds": 3600, "fileName": "optional.txt", "mimeType": "text/plain" }`.
- `GET /api/shares/{id}` — atomically retrieve and consume a share.

The encryption key is not part of the API payload. The frontend puts it only in the URL fragment.

## Production checklist

Before public deployment: use HTTPS; replace in-memory storage with a reviewed encrypted-storage design; add rate limiting and quotas; add request-size limits at the reverse proxy; configure strict CORS; add operational monitoring without logging secrets; test concurrency and expiry; review CSP and dependency supply chain; conduct an independent security assessment.

## License

No license has been selected yet. All rights reserved by default.
