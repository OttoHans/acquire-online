# ACQUIRE v2 — Async Multiplayer with Push Notifications

Real-time + async multiplayer Acquire. Built with Node.js, WebSockets, Postgres, and Web Push.

## What's new in v2
- **Async turns** — game state persists in Postgres; hop on, take your turn, hop off
- **Push notifications** — native browser/phone alerts when it's your turn
- **Board zoom & pan** — pinch to zoom on mobile, scroll wheel on desktop
- **Game PINs** — share a 6-digit code for friends to join

## Deploy to Railway

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Acquire v2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/acquire-online.git
git push -u origin main
```

### Step 2 — Create Railway project
1. Go to railway.app → New Project → Deploy from GitHub repo
2. Select your repository
3. Railway detects Node.js and deploys automatically

### Step 3 — Add Postgres database
1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway auto-sets the `DATABASE_URL` environment variable — nothing else needed

### Step 4 — Set VAPID keys (for push notifications)
Push notifications require a persistent key pair. Generate them once:
```bash
node -e "const wp=require('web-push'); const k=wp.generateVAPIDKeys(); console.log('PUBLIC:', k.publicKey); console.log('PRIVATE:', k.privateKey);"
```
Then in Railway → your service → **Variables**, add:
- `VAPID_PUBLIC` = the public key printed above
- `VAPID_PRIVATE` = the private key printed above

> If you skip this step the app still works, but push subscriptions reset on every server restart.

### Step 5 — Get your domain
Railway → your service → **Settings** → **Networking** → **Generate Domain**

Share the URL with friends. They enter a name, you create a game, share the 6-digit PIN.

## iOS Push Notification Setup
Safari on iPhone only supports push when the site is added to the Home Screen:
1. Open the game URL in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Open the app from your home screen
5. Tap **Enable** when prompted

## Run Locally
```bash
npm install
# Optional: set DATABASE_URL to a local Postgres connection string
# Without it, the server starts but game state won't persist across restarts
npm start
```
Then open http://localhost:3000

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes (prod) | Postgres connection string (auto-set by Railway) |
| `VAPID_PUBLIC` | Recommended | Web Push public key |
| `VAPID_PRIVATE` | Recommended | Web Push private key |
| `PORT` | No | Server port (default 3000) |
