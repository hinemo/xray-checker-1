# Local Run Guide

This repository can run locally without Docker.

## Requirements

- Go 1.25+
- Node.js 20+
- npm 10+

## 1) Setup once

```powershell
./scripts/setup-local.ps1
```

## 2) Start in integrated mode (new frontend served by backend)

```powershell
./scripts/run-local.ps1 -SubscriptionUrl "https://your-subscription-url"
```

This mode builds the React UI and serves it through backend static route `/static/*`.

## 3) Start in split mode (frontend dev server + backend)

```powershell
./scripts/run-local.ps1 -SubscriptionUrl "https://your-subscription-url" -FrontendDev
```

- Frontend: [http://127.0.0.1:5173](http://127.0.0.1:5173)
- Backend API: [http://127.0.0.1:2112](http://127.0.0.1:2112)

## Notes

- If your backend is protected with basic auth, open mode or provide browser credentials for API calls.
- Frontend uses `VITE_API_BASE` for API target.
