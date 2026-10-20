# Development

## Requirements and install

Use Node.js 22.13+ (22 LTS) or 24+ and npm. From the repository root:

```powershell
npm ci
npm ci --prefix api
```

The lockfiles pin package versions and integrity hashes but omit registry tarball URLs, so npm uses the registry configured for the environment. If the approved Microsoft proxy is required, use `npm run setup:approved`; this selects `https://packagefeedproxy.microsoft.io/npm/` for that command without changing saved npm settings or lockfiles. `npm run setup:dependencies` uses the current npm registry.

## Local app and sync

Run `npm run dev` and open <http://127.0.0.1:5173> for local-only use. To test sign-in and sync, copy `api\local.settings.example.json` to `api\local.settings.json`, configure two independent member tokens and names, then start these processes in separate terminals:

```powershell
# Local Azure Table Storage emulator; keep its data in the ignored .azure folder.
.\api\node_modules\.bin\azurite-table.cmd --silent --skipApiVersionCheck --location .\.azure\azurite

# API and frontend
npm --prefix api run dev
npm run dev
```

Generate a token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and repeat it for the second member. These are credentials: keep them private and share each only with its member. Local development mode is restricted to loopback addresses. Never commit `local.settings.json`, CSV exports, or backups.

To check the installable production app shell locally:

```powershell
npm run build
npm run preview -- --port 5173
```

The service worker and offline reload behavior are enabled in production builds, not in the Vite development server. A phone needs an HTTPS deployment to install or reach the app; a computer's loopback address is not available to another device.

## Checks

```powershell
npm run lint
npm test
npm run build
npm run build:api
```

The API integration suite uses the local emulator:

```powershell
$env:RUN_AZURE_TESTS = "1"
npm test -- tests\api.integration.test.ts
```

The browser suite builds against the production preview and uses a fresh synthetic household. Start the emulator first, ensure ports 5173 and 7071 are free, then run:

```powershell
npx playwright install chromium
npm run test:e2e
```

The CI workflow runs lint, unit tests, frontend and API builds, emulator-backed API tests, and Playwright browser tests. For focused UI and offline workflows, see [browser validation](../.github/skills/browser-validation/SKILL.md) and [offline-sync validation](../.github/skills/offline-sync-validation/SKILL.md).
