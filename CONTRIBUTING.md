# Contributing to Flixty

Thank you for taking the time to contribute. Flixty is a community-driven open-source project and all contributions are welcome — bug fixes, new features, documentation improvements, and platform integrations.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Project Structure](#project-structure)
- [Adding a New Platform](#adding-a-new-platform)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Style Guide](#style-guide)

---

## Code of Conduct

Be respectful. Constructive criticism is welcome; personal attacks are not. We are here to build something useful together.

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/your-username/flixty.git
   cd flixty
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Fill in the credentials for the platforms you are working on
   ```
5. **Start the dev server:**
   ```bash
   npm run dev
   ```
6. Open `http://localhost:3000` and confirm the app loads correctly.

---

## How to Contribute

### 1. Find something to work on

- Check the [Issues](https://github.com/nexusrun/flixty/issues) tab for open bugs and feature requests
- Look for issues labelled `good first issue` if you are new to the codebase
- If you have an idea not already filed, open an issue first and discuss it before building

### 2. Create a branch

Branch off `main` with a descriptive name:

```bash
git checkout -b fix/schedule-timezone-bug
git checkout -b feature/bluesky-platform
git checkout -b docs/improve-setup-guide
```

### 3. Make your changes

- Keep commits focused — one logical change per commit
- Write clear commit messages (see [Style Guide](#style-guide))
- Test your changes locally before submitting

### 4. Open a Pull Request

Push your branch and open a PR against `main`:

```bash
git push origin your-branch-name
```

Fill in the PR template with:
- What the change does
- Why it is needed
- How to test it
- Screenshots if the change affects the UI

---

## Pull Request Guidelines

- **One PR per concern** — do not bundle unrelated changes
- **Keep diffs small** — easier to review and faster to merge
- **Do not commit secrets** — never include API keys, `.env` files, or tokens
- **Do not commit `data/`** — store.json and uploads are gitignored for a reason
- **Update the README** if your change affects setup, configuration, or the API
- PRs that break existing functionality without a documented reason will not be merged

---

## Project Structure

```
flixty/
├── server.js          # Express entry point — routing and middleware setup
├── lib/
│   ├── auth.js        # Password hashing (scrypt) and requireAuth middleware
│   ├── scheduler.js   # node-cron job that fires scheduled posts
│   └── store.js       # JSON flat-file read/write helpers
├── routes/
│   ├── user.js        # User auth — register, login, logout, Google Sign-In
│   ├── auth.js        # Platform OAuth flows
│   ├── posts.js       # Publish and schedule endpoints
│   ├── ai.js          # Anthropic AI content generation
│   └── live.js        # Live stream create/end/status
├── platforms/
│   ├── twitter.js
│   ├── linkedin.js
│   ├── facebook.js
│   ├── instagram.js
│   ├── youtube.js
│   └── tiktok.js
└── public/
    └── index.html     # Entire frontend — single HTML file, Vanilla JS + Tailwind
```

---

## Adding a New Platform

To add a new social platform (e.g. Bluesky, Threads, Pinterest):

1. **Create `platforms/yourplatform.js`** and export at minimum:
   - `getAuthUrl(state)` — returns the OAuth authorization URL
   - `exchangeCode(code)` — exchanges the auth code for tokens
   - `postContent(token, text, mediaUrl)` — publishes a post

2. **Add OAuth routes in `routes/auth.js`:**
   - `GET /yourplatform` — initiate OAuth (add `requireAuth`)
   - `GET /yourplatform/callback` — handle callback and `saveToken`
   - `DELETE /yourplatform` — disconnect (add `requireAuth`)

3. **Add to `routes/posts.js`** — handle the platform in the `POST /publish` route

4. **Add the env vars** to `.env.example` with a comment linking to the developer portal

5. **Add the platform to the frontend** in `public/index.html`:
   - Sidebar connection entry with status dot
   - Platform toggle in the compose view
   - Live preview tab (if applicable)

6. **Document it** in `README.md` under Platform Setup

---

## Reporting Bugs

Open a [GitHub Issue](https://github.com/nexusrun/flixty/issues/new) and include:

- **What you expected** to happen
- **What actually happened**
- **Steps to reproduce** the issue
- **Environment** — Node.js version, OS, deployment platform
- **Relevant logs** — server console output, browser console errors
- **Do not include** API keys, tokens, or any secrets in the issue

---

## Suggesting Features

Open a [GitHub Issue](https://github.com/nexusrun/flixty/issues/new) with the label `enhancement` and describe:

- The problem you are trying to solve
- Your proposed solution
- Any alternatives you considered
- Whether you are willing to implement it yourself

---

## Style Guide

### Commits

Use the imperative mood and keep the first line under 72 characters:

```
Add Bluesky platform integration
Fix Facebook live stream permission error
Update README with TikTok sandbox instructions
Remove unused variable in scheduler.js
```

Avoid:
```
added bluesky
fixed stuff
WIP
```

### JavaScript

- ES Modules (`import`/`export`) throughout — no `require()`
- No TypeScript — keep the entry barrier low
- No unnecessary dependencies — prefer Node.js built-ins where possible
- Async/await over raw Promises
- Keep route handlers thin — business logic belongs in `lib/` or `platforms/`

### Frontend (`index.html`)

- Vanilla JS only — no frameworks
- Tailwind CSS utility classes — no custom CSS unless Tailwind cannot do it
- Functions should be small and named clearly
- All fetch calls use `credentials: 'include'` for session cookies

---

## Questions?

Open a [Discussion](https://github.com/nexusrun/flixty/discussions) or file an issue. We are happy to help you get oriented.
