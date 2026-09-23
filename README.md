# Flixty — Open-Source Social Media Creator Studio [![Deploy to NEXUS AI](https://nexusai.run/deploy-button.svg)](https://nexusai.run/deploy?repo=https://github.com/nexusrun/flixty)

Flixty is a self-hosted social media management platform. Write once, publish everywhere X, LinkedIn, Facebook, Instagram, TikTok, and YouTube  with AI-assisted content, scheduling, live streaming, and audience targeting. No SaaS fees, no vendor lock-in.

![Flixty Dashboard](flixty.png)

---

## Features

- **Multi-platform publishing** post to X, LinkedIn, Facebook, Instagram, TikTok, and YouTube from one interface
- **AI Assist** generate and rewrite content per platform using Claude (Anthropic) with platform-specific tone and character limits
- **Scheduler** schedule posts with a calendar view; a built-in cron job publishes them automatically
- **Live Streaming** create YouTube and Facebook live broadcasts and get RTMP credentials for OBS or any streaming software
- **Live Preview** see exactly how your post will look on each platform before publishing
- **Audience & Targeting** configure age, gender, location, language, interest, industry, device, and relationship targeting
- **MCP server** connect an MCP-compatible chatbot to publish, schedule, manage, and analyze content using your Flixty account
- **Google Sign-In** users can register and log in with email/password or Google OAuth
- **Responsive** full mobile UI with bottom navigation and slide-in drawer

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 18+, Express |
| Auth | express-session, crypto (scrypt), Google OAuth 2.0 |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`) |
| Database | PostgreSQL with startup migrations |
| MCP | Model Context Protocol SDK, Streamable HTTP, OAuth 2.1 + PKCE |
| Scheduling | node-cron |
| File uploads | multer |
| Frontend | Vanilla JS, Tailwind CSS (CDN), Material Symbols |

---

## Requirements

- Node.js 18 or higher
- npm
- PostgreSQL (required)
- A server or cloud platform (see [Deployment](#deployment))
- API credentials for the platforms you want to enable (all are optional except `SESSION_SECRET`)

---

## Quick Start (Local)

```bash
git clone https://github.com/nexusrun/flixty.git
cd flixty
npm install
cp .env.example .env
# Edit .env and set DATABASE_URL, SESSION_SECRET, and any provider credentials
npm run dev
```

Open `http://localhost:3000` in your browser.

- `npm run dev` starts with `--watch` (auto-restarts on file changes)
- `npm start` production start

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values you need. All platform keys are optional only configure the platforms you intend to use.

```env
PORT=3000
BASE_URL=https://your-domain.com   # public URL, used to build OAuth redirect URIs
SESSION_SECRET=replace-with-a-long-random-string

# PostgreSQL (required)
DATABASE_URL=postgres://user:password@host:5432/flixty

# X / Twitter
X_CLIENT_ID=
X_CLIENT_SECRET=

# LinkedIn
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_ENABLE_ORGANIZATIONS=false

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

# Optional AI Assist server fallbacks (users can also configure providers in AI Settings)
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=
OPENAI_API_KEY=
OPENAI_BASE_URL=
GEMINI_API_KEY=
GEMINI_BASE_URL=
```

> **Important:** `BASE_URL` must match the public URL of your deployment exactly (no trailing slash). All OAuth redirect URIs are constructed from this value.

`DATABASE_URL` is required. Flixty applies the SQL files in `lib/db/migrations/` automatically during startup, including the MCP OAuth tables. Keep `data/uploads/` on persistent storage in production because uploaded media is stored locally.

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

### AI Assist providers

AI Assist supports Anthropic, OpenRouter, OpenAI, and Google Gemini. Configure a provider and key in the dashboard’s **AI Settings**, or set a server fallback key in `.env`:

- [Anthropic API keys](https://console.anthropic.com) — `ANTHROPIC_API_KEY`
- [OpenRouter API keys](https://openrouter.ai/keys) — `OPENROUTER_API_KEY`
- [OpenAI API keys](https://platform.openai.com/api-keys) — `OPENAI_API_KEY`
- [Google AI Studio keys](https://aistudio.google.com/app/apikey) — `GEMINI_API_KEY`

OpenAI uses its compatible chat endpoint, while Gemini uses Google’s native `generateContent` API. Gemini’s default base URL is `https://generativelanguage.googleapis.com/v1beta`.

AI Assist preserves supplied facts, names, numbers, URLs, and handles and tailors output to each platform’s tone and character limit.

---

## MCP Server and Chatbot Integration

Flixty includes a remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server. An MCP-compatible chatbot can use the server to publish content, schedule posts, cancel scheduled posts, list publishing history, and inspect engagement analytics.

The MCP server is a remote Streamable HTTP endpoint:

```text
https://your-domain.com/mcp
```

It uses Flixty's built-in OAuth 2.1 authorization server with dynamic client registration and PKCE. A chatbot does not need a manually-created client secret. The first connection opens Flixty's consent screen; after approval, the chatbot receives a short-lived access token and a refresh token.

### Before connecting a chatbot

1. Deploy Flixty at a public HTTPS URL. `localhost` is suitable only for local clients running on the same machine.
2. Configure `BASE_URL` to the exact public origin, with no trailing slash.
3. Configure `DATABASE_URL` and start Flixty once so all migrations are applied.
4. Create a Flixty user account and sign in.
5. Connect the social accounts you want to use from the Flixty dashboard. MCP uses the same per-user platform connections as the web app; it does not bypass platform OAuth.
6. Confirm that `https://your-domain.com/health` returns `{ "ok": true }`.

### Connect from a chatbot

In the chatbot's MCP, Connectors, or Custom Integrations settings, add the remote server URL:

```text
https://your-domain.com/mcp
```

Allow the chatbot to discover the OAuth endpoints and complete the browser login/consent flow. If the client asks for an authorization server URL, use:

```text
https://your-domain.com/.well-known/oauth-authorization-server
```

If it asks for the protected resource metadata URL, use:

```text
https://your-domain.com/.well-known/oauth-protected-resource
```

Examples:

- **Claude.ai or another hosted chatbot:** add the URL as a custom/remote connector, then sign in to Flixty when the consent window appears.
- **Claude Desktop or another desktop MCP client:** use its remote MCP/HTTP connector configuration and enter the same URL. Client configuration names vary by version; use the OAuth discovery flow rather than pasting a bearer token.
- **ChatGPT or another MCP-enabled chatbot:** add the endpoint under its MCP, Apps, or Connectors settings, then complete Flixty's OAuth flow. Availability and UI labels depend on the client plan and version.

After the connection succeeds, try a read-only request such as:

```text
Show my Flixty publishing overview for the last 30 days.
```

For a write request, clearly identify the target platforms and media. For example:

```text
Publish this announcement to LinkedIn and Facebook: "We just launched our new community program."
```

The chatbot should ask for confirmation according to its own safety settings before calling a write tool.

### OAuth and security flow

Flixty exposes these protocol endpoints from the same origin as the app:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | OAuth server discovery metadata |
| `GET` | `/.well-known/oauth-protected-resource` | MCP resource metadata |
| `POST` | `/oauth/register` | Dynamic public-client registration |
| `GET` / `POST` | `/oauth/authorize` | Login and user consent |
| `POST` | `/oauth/token` | Exchange authorization codes or rotate refresh tokens |
| `POST` | `/mcp` | Streamable HTTP MCP requests |

For an MCP client that does not provide automatic discovery, the connection sequence is:

1. Read `/.well-known/oauth-protected-resource` to find the authorization server.
2. Read `/.well-known/oauth-authorization-server` to find registration, authorization, and token endpoints.
3. Register a public client with `POST /oauth/register`, supplying the chatbot's `client_name` and OAuth `redirect_uris`.
4. Generate a PKCE verifier/challenge pair and open the authorization endpoint with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, and a random `state`.
5. Let the user log in and approve access in Flixty, then validate `state` and exchange the returned code at `/oauth/token` with the PKCE verifier.
6. Send MCP requests to `/mcp` with `Authorization: Bearer <access_token>`. Refresh the token when it expires.

The authorization code flow requires `S256` PKCE. Access tokens expire after one hour; refresh tokens expire after 90 days and are rotated when used. Token values are stored as SHA-256 hashes, and every MCP request is mapped to the Flixty user who approved the connection. A client can access only that user's connected accounts, posts, schedules, and analytics.

To verify that the protected endpoint is active without exposing a token:

```bash
curl -i https://your-domain.com/mcp
```

The expected response is `401 Unauthorized` with a `WWW-Authenticate` header pointing to the protected-resource metadata endpoint. Do not put access or refresh tokens in the README, shell history, screenshots, or issue reports.

### MCP tools

All tools are registered for the authenticated Flixty user.

| Tool | What it does |
|---|---|
| `create_post` | Publishes immediately to one or more connected platforms |
| `schedule_post` | Schedules a future publication using an ISO 8601 date-time |
| `list_posts` | Lists recent published posts, newest first; `limit` is 1–50 and defaults to 10 |
| `list_scheduled` | Lists upcoming scheduled posts |
| `cancel_scheduled` | Cancels a scheduled post by its numeric `id` |
| `get_overview` | Returns totals and per-platform engagement for `7d`, `30d`, or `90d` |
| `get_top_posts` | Ranks posts by likes + comments + shares for a selected range, optionally filtered by platform |
| `get_hashtag_performance` | Groups engagement by hashtag for a selected range |

#### Publishing platforms

`create_post` and `schedule_post` accept:

```text
linkedin, facebook, instagram, youtube, tiktok
```

X/Twitter is intentionally not exposed through MCP because posting requires the paid X API tier in this project; use the Flixty web UI for the supported manual/web-publishing flow. TikTok publishing is sandbox/private-account only until the app is approved for public Content Posting API access. Instagram publishing uses the connected Facebook/Instagram integration.

#### Media inputs

Both publishing tools support:

- `imageUrl` — a public HTTP(S) image URL for Facebook or Instagram
- `videoUrl` — a public HTTP(S) video URL for YouTube or Facebook
- `imageData` / `videoData` — base64 media for files that are not publicly hosted
- `mediaMimeType` — required with inline data; supported types include JPEG, PNG, GIF, WebP, MP4, QuickTime, and WebM
- `thumbnailUrl` or `thumbnailData` — an optional YouTube thumbnail
- `thumbnailMimeType` — required when using `thumbnailData`
- `campaignName` — optional campaign name; for YouTube it is used as the video title

Inline media is capped at approximately 45 MB decoded, and the `/mcp` request body limit is 65 MB. URL downloads accept only HTTP(S), do not follow redirects, reject private/internal IP addresses, and allow only the media MIME types listed above. For scheduled video posts, Flixty downloads the media while scheduling so it is available when the scheduler runs.

### MCP troubleshooting

- **OAuth discovery fails:** check that `BASE_URL` is public HTTPS and has no trailing slash. Verify both `.well-known` URLs in a browser or with `curl`.
- **The chatbot connects but sees no platforms:** log in to Flixty and connect the desired social accounts in the dashboard. Reconnect the MCP client after changing account connections if necessary.
- **A tool reports an expired token:** reconnect the chatbot or allow it to use its refresh token. Access tokens last one hour.
- **A media request fails:** use a public URL with an allowed MIME type, or provide valid base64 plus its MIME type. For larger files, host the file at a public HTTPS URL.
- **A TikTok post is private:** this is expected in the current sandbox implementation until TikTok approves public posting for the app.
- **A request to X fails:** X is not one of the MCP publishing targets; publish it through the Flixty web interface.

---

## Deployment

### NexusAI (Recommended)

Flixty is optimized for deployment on [NEXUS AI](https://nexusai.run).

1. Push your code to GitHub
2. Connect your repo in the NexusAI dashboard
3. Add all environment variables from your `.env` in **Settings → Environment Variables**
4. Set `BASE_URL` to your NexusAI app URL (e.g. `https://your-app.nexusai.run`)
5. Deploy

### Self-Hosted (VPS / Docker)

Flixty requires a PostgreSQL database. The included Dockerfile builds the app container; provision PostgreSQL separately or attach a managed PostgreSQL service and set `DATABASE_URL`.

```bash
# Clone and install
git clone https://github.com/your-username/flixty.git
cd flixty
npm install

# Configure
cp .env.example .env
nano .env   # fill in DATABASE_URL, BASE_URL, SESSION_SECRET, and provider keys

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

---

## Data Storage

Flixty stores application data in PostgreSQL. Database migrations run automatically when the server starts. The database includes:

- User accounts and connected platform OAuth tokens
- Published posts and platform results
- Scheduled posts and live stream sessions
- Analytics metrics and AI insights
- MCP clients, authorization codes, access tokens, and refresh tokens

Uploaded images, videos, and thumbnails are stored under `data/uploads/`, not in PostgreSQL. **For production**, mount `data/` on persistent storage as well as provisioning persistent PostgreSQL. Losing `data/uploads/` can make scheduled media unavailable.

> `data/` is in `.gitignore` by default — tokens and user data are never committed.

---

## Project Structure

```
flixty/
├── server.js              # Express app entry point
├── lib/
│   ├── auth.js            # Password hashing (scrypt), requireAuth middleware
│   ├── db/                # PostgreSQL pool, migrations, and schema
│   ├── mcp/               # MCP tools and safe media resolution
│   ├── mcpOAuth/          # MCP OAuth 2.1 / PKCE persistence and URLs
│   ├── scheduler.js       # node-cron job for scheduled posts
│   └── store.js           # PostgreSQL data access helpers
├── routes/
│   ├── user.js            # Register, login, logout, Google Sign-In
│   ├── auth.js            # Platform OAuth flows (X, LinkedIn, Facebook, YouTube, TikTok)
│   ├── posts.js           # Publish now, schedule, list posts
│   ├── ai.js              # AI content generation (Anthropic)
│   ├── live.js            # Live stream create/end/status
│   ├── analytics.js       # Engagement and AI insights
│   ├── oauthServer.js     # MCP OAuth discovery, registration, consent, tokens
│   └── mcp.js             # Bearer-protected Streamable HTTP MCP endpoint
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
│   └── uploads/            # Local media files used by publishing/scheduling
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
| `POST` | `/api/ai/improve` | Required | Improve existing content |
| `POST` | `/api/ai/adapt` | Required | Adapt content for a target platform |
| `POST` | `/api/ai/hashtags` | Required | Suggest relevant hashtags |
| `POST` | `/api/ai/image` | Required | Generate an image and save it to uploads |
| `POST` | `/api/ai/video` | Required | Start an asynchronous video generation job |
| `GET` | `/api/ai/video/status/:jobId` | Required | Poll a video generation job |
| `GET` / `PUT` | `/api/ai/settings` | Required | Read or update the user's AI provider settings |

### Live Streaming
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/live/start` | Required | Create YouTube/Facebook broadcast |
| `POST` | `/api/live/:id/end` | Required | End a broadcast |
| `GET` | `/api/live/:id/status` | Required | Poll viewer counts |
| `GET` | `/api/live` | Required | List stream history |

### MCP

The MCP endpoint is protected by OAuth bearer tokens. MCP clients should use the discovery and authorization flow described in [MCP Server and Chatbot Integration](#mcp-server-and-chatbot-integration) rather than hard-coding tokens.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/.well-known/oauth-authorization-server` | Public | OAuth server metadata |
| `GET` | `/.well-known/oauth-protected-resource` | Public | Protected MCP resource metadata |
| `POST` | `/oauth/register` | Public | Register an MCP public client dynamically |
| `GET` / `POST` | `/oauth/authorize` | Session / consent | Authenticate and approve an MCP client |
| `POST` | `/oauth/token` | Public | Exchange a code or rotate a refresh token |
| `POST` | `/mcp` | Bearer token | Handle MCP JSON-RPC / Streamable HTTP requests |

---

## Known Limitations

- **X/Twitter** requires a paid API plan ($200/month Basic) for posting — the free tier has no write credits
- **TikTok** and **Instagram** Live streaming have no public API — RTMP credentials are not available for these platforms
- **MCP publishing** supports LinkedIn, Facebook, Instagram, YouTube, and TikTok; X/Twitter is not exposed as an MCP publishing target
- **Storage** uses PostgreSQL, while uploaded media remains on the local filesystem; use persistent database and file storage for production
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

Flixty is an open-source project released under the MIT license. You may use, modify, self-host, and redistribute it under the terms in [LICENSE](LICENSE).
