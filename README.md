# JotBird User Worker 🚀

This is your personal worker for the Obsidian JotBird plugin. It securely syncs your public notes to the global hub using a Passport (JWT) system.

## One-Click Deployment

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/karamimoheb/Quick-Share-obsidian-worker)

## Setup Instructions
1. Deploy using the button above.
2. Go to Cloudflare Dashboard -> **D1 SQL Database** -> Create a database named `jotbird_db`.
3. Go to your new Worker -> **Settings -> Variables**.
4. Bind your D1 database (`Variable name: DB`).
5. Set the following Environment Variables:
   - `API_KEY`: Your private key for the Obsidian plugin.
   - `MASTER_WORKER_URL`: The URL of the central JotBird Hub.
   - `MASTER_API_KEY`: The shared secret to authenticate with the Hub.
