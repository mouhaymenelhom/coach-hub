# Coach Hub (MVP)

A coach publishes videos and lives. Members sign in with Google, watch the coach's new content, message the coach in real time, and chat with a free AI assistant.

**Stack:** Node.js, Express, SQLite, Socket.IO, plain HTML/CSS/JS (no build step).

## What's included

| Area | Details |
|---|---|
| Member login (public) | `/` — Google OAuth2. The server verifies the Google ID token, then issues its own JWT. |
| Coach login (private) | `/coach/login` — username/password (`admin` / `admin` for now). Not linked from any public page. |
| Member home | `/app` — latest videos (with NEW badge and live toast when the coach publishes), a LIVE NOW banner. |
| Lives | Coach adds a YouTube/Vimeo live link, then presses **Go live** / **End live**. |
| Messaging | Messenger-style chat, member ↔ coach, real time (Socket.IO), unread counters for the coach. |
| AI chatbot | Any OpenAI-compatible free provider (default: Groq). |
| Coach dashboard | `/coach` — publish/delete videos (link or file upload), manage lives, read and reply to messages. |

## Setup

### 1. Install
```bash
npm install
cp .env.example .env
```
Requires Node 18+.

### 2. Google OAuth2 client
1. Go to https://console.cloud.google.com/apis/credentials and create a project.
2. Configure the OAuth consent screen (External; add yourself as a test user while in testing mode).
3. **Create credentials → OAuth client ID → Web application.**
4. Under **Authorized JavaScript origins** add `http://localhost:3000` (and your real domain later).
5. Copy the Client ID into `GOOGLE_CLIENT_ID` in `.env`.

### 3. JWT secret
Put a long random string in `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 4. Free AI model (optional but needed for the chatbot)
Create a free key at https://console.groq.com and set `AI_API_KEY`. You can switch provider/model through `AI_BASE_URL` and `AI_MODEL` (see `.env.example`). Free model names change over time, so update `AI_MODEL` if the provider retires one.

### 5. Run
```bash
npm start
```
- Members: http://localhost:3000
- Coach: http://localhost:3000/coach/login (`admin` / `admin`)

The coach account is created on first start. To change credentials, set `COACH_USERNAME` / `COACH_PASSWORD` in `.env` **before the first run** (or delete `data.db` to re-seed).

## How auth works
- **Members:** Google Sign-In returns an ID token → `POST /api/auth/google` verifies it with `google-auth-library` → server returns a JWT (`role: user`, 12 h).
- **Coach:** `POST /api/auth/coach` checks a bcrypt-hashed password → JWT (`role: coach`).
- Every API route and every Socket.IO connection checks the JWT and the role. Members can't call coach routes.
- Login endpoints are rate-limited.

## Project layout
```
server.js        API, auth, Socket.IO, chatbot proxy
db.js            SQLite schema + coach seeding
public/          index.html (member login), app.html/app.js (member app),
                 coach-login.html, coach.html/coach.js, common.js, style.css
uploads/         uploaded videos (created at runtime)
data.db          SQLite database (created at runtime)
```

## Before going to production
- **Change the coach password** (`admin`/`admin` is for local testing only) and set a strong `JWT_SECRET`.
- Serve over **HTTPS** (e.g. behind Caddy/Nginx) and add your domain to Google's authorized origins.
- JWTs live in `localStorage` for simplicity. Move to httpOnly cookies + CSRF protection for hardening, and add a CSP header.
- Video uploads are stored on local disk (500 MB limit). For real traffic use object storage + a CDN, or keep using YouTube/Vimeo links.
- YouTube Live links must be of the form `youtube.com/live/<id>` or `youtube.com/watch?v=<id>` (channel `/@name/live` links can't be embedded).
- Add pagination to videos/messages, message read receipts for members, and password reset/2FA for the coach.
