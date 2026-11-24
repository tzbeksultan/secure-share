# Secure Share

Private one-time sharing MVP: React/Vite frontend, Go API, PostgreSQL.

## Security model
- Browser-side AES-256-GCM encryption using Web Crypto.
- The 256-bit secret stays in the URL fragment and is not sent in HTTP requests.
- The API stores ciphertext and SHA-256 hash of the secret, never the decryption key.
- Optional PIN is stored as a bcrypt hash.
- A PostgreSQL transaction locks and consumes a share exactly once.
- Expiration is enforced on read (1 hour, 24 hours, or 7 days).

## Deploy on Render
- PostgreSQL: create in Frankfurt (or same region as API).
- API: Docker runtime, root Dockerfile, health check path /healthz. Set DATABASE_URL from the database's internal connection string and FRONTEND_ORIGIN to the static site's HTTPS origin.
- Frontend: static site; build command: cd web && npm install && npm run build; publish path: web/dist; set VITE_API_URL to the API HTTPS URL.

## Local development
- API: set DATABASE_URL and run go run .
- Frontend: cd web && npm install && npm run dev. Set VITE_API_URL if API is not served on the same origin.

## MVP limitations
This version shares text only. It cannot prevent screenshots, screen recording, copying, or photographing another device. It has not been independently audited; do not use it for banking credentials, customer data, or regulated production secrets until security review and hardening are complete.
