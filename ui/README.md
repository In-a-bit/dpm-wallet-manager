# Admin UI

React + Vite single-page app for dpm-wallet-manager. The backend serves the built files at `/admin`
(with an SPA fallback), so every page URL is `/admin/...`.

Use the Node version from the repo's `.nvmrc` (`source ~/.nvm/nvm.sh && nvm use` from the repo root).

## Develop

```sh
cd ui
npm install
npm run dev        # http://localhost:5173/admin/ ; /v1 is proxied to http://localhost:3000
```

Run the backend on port 3000 alongside it. Sign in with a UI user (username/password).

## Build

```sh
npm run build      # typechecks, then writes ../dist/ui (index.html + assets under /admin/assets/)
npm run typecheck
```

`nest build` empties `dist/` first, so build the backend before the UI.

## Notes

- No runtime dependencies beyond React. Plain CSS in `src/styles.css`; the colour tokens match the setup page.
- Works under the server's CSP (`default-src 'self'`): no inline scripts, no injected `<style>`, no `innerHTML`.
- `src/api.ts` is the typed client. Every request sends `X-Requested-With: dpmm-admin` (the server's
  CSRF guard) and relies on the `dpmm_session` HttpOnly cookie; a 401 sends the user back to sign in.
