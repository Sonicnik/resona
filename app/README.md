# Resona app UI

React + Vite UI for the local backend, ported from [`../design/prototype.html`](../design/prototype.html). Run the backend first (`cd ../backend && npm run demo`), then `npm run dev` and open http://localhost:1420. Vite proxies `/api` to `127.0.0.1:4317`.

The Mac app in [`../desktop/`](../desktop/) wraps this UI in an Electron window; there the backend serves the built `dist/`.
