# Manual test plan – uninstall flow (core + web)

## Preconditions
- Running PostgreSQL used by `hekatoncheiros-core`.
- `hekatoncheiros-core` and `hekatoncheiros-web` are running locally.
- Logged in as a user with `platform.apps.manage` privilege.
- At least one app is installed and visible in **Manage Apps**.

## Test cases

### 1) Successful uninstall (happy path)
1. Open **Manage Apps**.
2. Click **Uninstall** on an installed app.
3. In wizard step **Confirm**, verify app name + base URL are shown.
4. Verify confirm button is disabled until checkbox **Rozumím dopadu odinstalace** is checked.
5. Confirm uninstall.
6. Verify wizard switches to **Running** (spinner, cannot close via ESC/backdrop).
7. Verify app disappears from table immediately (optimistic update).
8. Verify wizard ends in **Success** and can be closed manually.

Expected:
- No `window.confirm()` or browser alert.
- App is removed from list without full page reload.

### 2) Persistence check after refresh
1. After successful uninstall, refresh page manually (F5).
2. Verify removed app is still missing from installed list.

Expected:
- Backend DELETE removed row from `core.installed_apps`.
- GET `/api/v1/apps/installed` no longer returns the app.

### 3) Error handling and rollback
1. Force backend error (e.g., stop core API briefly, or induce 401/403 by using unauthorized user).
2. Start uninstall flow and confirm.
3. Verify wizard ends in **Error**.
4. Verify error panel shows HTTP status + message.
5. Verify app returns to list (rollback of optimistic update).
6. Click **Retry** and verify flow retries uninstall.

Expected:
- UI never shows success for non-2xx response.
- Error is visible in wizard and logged to browser console.

### 4) Not installed (404) behavior
1. Trigger uninstall for app_id that no longer exists (or uninstall twice).
2. Verify backend responds `404 { "message": "App not installed" }`.
3. Verify wizard shows **Error** with HTTP 404 detail.

Expected:
- No false success state.

## Backend diagnostics (dev/test)
- During uninstall route execution, check core logs for debug record including:
  - `app_id`
  - `rowCount`
  - `current_database`
  - `inet_server_addr`

This helps detect mismatched DB/instance issues.
