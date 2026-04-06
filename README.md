# Flixty — Open-Source Social Media Creator Studio

Flixty is a self-hosted social media management platform. Write once, publish everywhere — X, LinkedIn, Facebook, Instagram, TikTok, and YouTube — with AI-assisted content, scheduling, live streaming, and audience targeting. No SaaS fees, no vendor lock-in.

![Flixty Dashboard](flixty.png)

---

## Features

- **Multi-platform publishing** — post to X, LinkedIn, Facebook, Instagram, TikTok, and YouTube from one interface
- **AI Assist** — generate and rewrite content per platform using Claude (Anthropic) with platform-specific tone and character limits
- **Scheduler** — schedule posts with a calendar view; a built-in cron job publishes them automatically
- **Live Streaming** — create YouTube and Facebook live broadcasts and get RTMP credentials for OBS or any streaming software
- **Live Preview** — see exactly how your post will look on each platform before publishing
- **Audience & Targeting** — configure age, gender, location, language, interest, industry, device, and relationship targeting
- **Google Sign-In** — users can register and log in with email/password or Google OAuth
- **Responsive** — full mobile UI with bottom navigation and slide-in drawer

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 18+, Express |
| Auth | express-session, crypto (scrypt), Google OAuth 2.0 |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`) |
| Storage | JSON flat-file (`data/store.json`) |
| Scheduling | node-cron |
| File uploads | multer |
| Frontend | Vanilla JS, Tailwind CSS (CDN), Material Symbols |

---

## Requirements

- Node.js 18 or higher
- npm
- A server or cloud platform (see [Deployment](#deployment))
- API credentials for the platforms you want to enable (all are optional except `SESSION_SECRET`)

---

## Quick Start (Local)

```bash
git clone https://github.com/your-username/flixty.git
cd flixty
npm install
cp .env.example .env
# Edit .env and fill in your credentials
npm run dev
```

Open `http://localhost:3000` in your browser.

- `npm run dev` — starts with `--watch` (auto-restarts on file changes)
- `npm start` — production start

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values you need. All platform keys are optional — only configure the platforms you intend to use.

```env
PORT=3000
BASE_URL=https://your-domain.com   # public URL, used to build OAuth redirect URIs
SESSION_SECRET=replace-with-a-long-random-string

# X / Twitter
X_CLIENT_ID=
X_CLIENT_SECRET=

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=

# Facebook + Instagram
FB_APP_ID=
FB_APP_SECRET=

# TikTok
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=

# Google (YouTube + Google Sign-In share one client)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Anthropic (AI Assist)
ANTHROPIC_API_KEY=
```

> **Important:** `BASE_URL` must match the public URL of your deployment exactly (no trailing slash). All OAuth redirect URIs are constructed from this value.

---

## Platform Setup

### Google — YouTube & Google Sign-In

Both YouTube publishing and Google Sign-In use the **same** Google OAuth client.

1. Go to [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Enable these APIs in your project:
   - **YouTube Data API v3**
   - **YouTube Analytics API** (optional)
4. Add these **Authorized redirect URIs**:
   ```
   https://your-domain.com/auth/youtube/callback
   https://your-domain.com/api/user/google/callback
   http://localhost:3000/auth/youtube/callback        (local dev)
   http://localhost:3000/api/user/google/callback     (local dev)
   ```
5. Copy `Client ID` → `GOOGLE_CLIENT_ID` and `Client Secret` → `GOOGLE_CLIENT_SECRET`
6. Add your Google account as a **Test User** under **OAuth consent screen → Test users** (required while the app is in Testing mode for YouTube scopes)

### Facebook & Instagram

Facebook and Instagram share a single OAuth flow.

1. Go to [Facebook Developers](https://developers.facebook.com/apps) → **Create App**
2. Add these products: **Facebook Login**, **Instagram Basic Display**
3. Required permissions:
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `instagram_content_publish`
   - `publish_video` (required for Facebook Live)
4. Add the redirect URI in **Facebook Login → Settings → Valid OAuth Redirect URIs**:
   ```
   https://your-domain.com/auth/facebook/callback
   ```
5. Set `FB_APP_ID` and `FB_APP_SECRET` from **Settings → Basic**
6. Instagram requires a **Facebook Page** linked to an Instagram Professional account

> **Note:** Facebook requires App Review for production use. In development mode, add test users under **Roles → Test Users**.

### LinkedIn

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps) → **Create app**
2. Request the **Share on LinkedIn** and **Sign In with LinkedIn** products
3. Add the redirect URI:
   ```
   https://your-domain.com/auth/linkedin/callback
   ```
4. Copy `Client ID` and `Client Secret` to your `.env`

### X / Twitter

> **Warning:** X API free tier no longer includes posting credits. You need the **Basic plan ($200/month)** or higher to post via the API.

1. Go to [X Developer Portal](https://developer.twitter.com) → **Create Project & App**
2. Enable **OAuth 2.0** with PKCE
3. Set app permissions to **Read and Write**
4. Add the callback URL:
   ```
   https://your-domain.com/auth/x/callback
   ```
5. Copy `Client ID` and `Client Secret` to your `.env`

### TikTok

1. Go to [TikTok Developers](https://developers.tiktok.com) → **Create app**
2. Enable the **Content Posting API**
3. Add the redirect URI:
   ```
   https://your-domain.com/auth/tiktok/callback
   ```
4. Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`

> **Note:** TikTok requires manual app review before the Content Posting API works in production. In sandbox mode, add your TikTok account as a test user.

### Anthropic (AI Assist)

1. Go to [Anthropic Console](https://console.anthropic.com) → **API Keys**
2. Create a key and set `ANTHROPIC_API_KEY`

AI Assist uses `claude-sonnet-4-6` to generate and rewrite content tailored to each platform's tone and character limits.

---

## Deployment

### NexusAI (Recommended)

Flixty is optimized for deployment on [NexusAI](https://nexusai.run).

1. Push your code to GitHub
2. Connect your repo in the NexusAI dashboard
3. Add all environment variables from your `.env` in **Settings → Environment Variables**
4. Set `BASE_URL` to your NexusAI app URL (e.g. `https://your-app.nexusai.run`)
5. Deploy

### Self-Hosted (VPS / Docker)

```bash
# Clone and install
git clone https://github.com/your-username/flixty.git
cd flixty
npm install

# Configure
cp .env.example .env
nano .env   # fill in your values

# Run with PM2 (recommended for production)
npm install -g pm2
pm2 start server.js --name flixty
pm2 save
```

Use **nginx** as a reverse proxy:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then add SSL with Certbot:
```bash
certbot --nginx -d your-domain.com
```

### Railway / Render / Fly.io

These platforms all work with standard Node.js deployments:

1. Connect your GitHub repo
2. Set the start command to `npm start`
3. Add environment variables in the platform dashboard
4. Set `BASE_URL` to the assigned domain

---

## Data Storage

All data is stored in `data/store.json` — a flat JSON file on the local filesystem. This includes:

- Connected platform tokens (OAuth)
- Published posts history
- Scheduled posts queue
- Live stream sessions
- User accounts

**For production**, make sure `data/` is on a persistent volume. On NexusAI, Railway, and similar platforms, mount a persistent disk at `/data` or equivalent and update `DATA_DIR` if needed.

> `data/` is in `.gitignore` by default — tokens and user data are never committed.

---

## Project Structure

```
flixty/
├── server.js              # Express app entry point
├── lib/
│   ├── auth.js            # Password hashing (scrypt), requireAuth middleware
│   ├── scheduler.js       # node-cron job for scheduled posts
│   └── store.js           # JSON file read/write helpers
├── routes/
│   ├── user.js            # Register, login, logout, Google Sign-In
│   ├── auth.js            # Platform OAuth flows (X, LinkedIn, Facebook, YouTube, TikTok)
│   ├── posts.js           # Publish now, schedule, list posts
│   ├── ai.js              # AI content generation (Anthropic)
│   └── live.js            # Live stream create/end/status
├── platforms/
│   ├── twitter.js
│   ├── linkedin.js
│   ├── facebook.js
│   ├── instagram.js
│   ├── youtube.js
│   └── tiktok.js
├── public/
│   └── index.html         # Single-page frontend (Vanilla JS + Tailwind)
├── data/                  # Auto-created at runtime (gitignored)
│   ├── store.json
│   └── uploads/
├── .env.example
└── package.json
```

---

## API Reference

### User Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/user/register` | Register with name, email, password |
| `POST` | `/api/user/login` | Login with email, password |
| `POST` | `/api/user/logout` | End session |
| `GET` | `/api/user/me` | Get current user |
| `GET` | `/api/user/google` | Initiate Google Sign-In |
| `GET` | `/api/user/google/callback` | Google OAuth callback |

### Platform OAuth
| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/status` | Connection status for all platforms |
| `GET` | `/auth/{platform}` | Initiate OAuth for platform |
| `GET` | `/auth/{platform}/callback` | OAuth callback |
| `DELETE` | `/auth/{platform}` | Disconnect platform |

Platforms: `x`, `linkedin`, `facebook`, `youtube`, `tiktok`

### Posts
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/publish` | Required | Publish to selected platforms |
| `POST` | `/api/schedule` | Required | Schedule a post |
| `GET` | `/api/posts` | — | List published posts |
| `GET` | `/api/scheduled` | — | List scheduled posts |
| `DELETE` | `/api/scheduled/:id` | Required | Cancel a scheduled post |

### AI
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/ai/generate` | Required | Generate content for a platform |
| `POST` | `/api/ai/rewrite` | Required | Rewrite existing content |

### Live Streaming
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/live/start` | Required | Create YouTube/Facebook broadcast |
| `POST` | `/api/live/:id/end` | Required | End a broadcast |
| `GET` | `/api/live/:id/status` | Required | Poll viewer counts |
| `GET` | `/api/live` | Required | List stream history |

---

## Known Limitations

- **X/Twitter** requires a paid API plan ($200/month Basic) for posting — the free tier has no write credits
- **TikTok** and **Instagram** Live streaming have no public API — RTMP credentials are not available for these platforms
- **Storage** is a local JSON file — not suitable for multi-instance or high-volume deployments without replacing `lib/store.js`
- **Sessions** are in-memory — users are logged out on server restart unless you add a session store (e.g. connect-redis)

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.
