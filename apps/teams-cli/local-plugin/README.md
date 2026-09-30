# Teams CLI local plugin

Read Teams chats from Codex through a local Go CLI and MCP server. Sign-in opens in your **system default browser**, using Microsoft's device-code flow. Electron, Chrome automation and browser-cookie extraction are not required.

This is an experimental personal integration built on the unofficial [FOSS Teams API library](https://github.com/fossteams/teams-api). It is not a Microsoft-supported application or an official Teams connector.

## Use

Start a new Codex chat after installing the plugin. Configure account profiles locally and ask to show your Teams accounts or recent chats.

Tools: `list_accounts`, `start_login`, `login_status`, `list_chats`, `read_messages`. Chats can be filtered by title; messages are returned as a recent page, at most 100 per call. Sending, channels, files and full-history search are not implemented. The CLI's transport blocks message writes.

When a session expires, ask to sign in again. A local page displays a code and a Microsoft sign-in link in the default browser. Enter that code on Microsoft's page and choose the indicated account. The plugin checks the organisation, account, token resource, expiry and matching user before saving the session.

## Runtime and storage

This build targets **macOS Apple Silicon** and requires **Node.js 22.12+**. Build the Go reader from the included source before using this source checkout. The launcher discovers Node on PATH, in nvm, or standard Homebrew locations. `npm ci` restores JavaScript dependencies if they were excluded from a source copy. Use `GO_BIN=/path/to/go sh scripts/build.sh` to rebuild the native CLI with Go 1.26.1 or newer.

Account configuration and access tokens live outside the plugin at `~/Library/Application Support/foss-teams/`. Directories have mode 0700 and credential files mode 0600. Tokens are stored locally as plaintext protected by those permissions, not in Keychain. They are not included in shared plugin files or tool results. Refresh tokens are used transiently to obtain the second Teams resource and then discarded; this prototype requires browser sign-in when access tokens expire. Uninstalling the plugin does not remove this separate data directory.

`accounts.json` contains an `accounts` array with `id`, `name`, `loginHint`, `tenantName`, and `tenantId` for each profile. IDs are lowercase letters, digits and hyphens. Account configuration is local to this installation and is not bundled when sharing. `FOSS_TEAMS_DATA_DIR` can override the data directory for testing.

Authentication uses the Teams desktop/mobile public client ID `1fec8e78-bce4-4aaf-ab1b-5451cc387264` and tenant-specific Microsoft OAuth endpoints. The Teams web client cannot complete this device flow without a client secret. Tenant policy can prevent sign-in; the plugin does not change tenant settings. See [Microsoft's device-code documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) and [Microsoft's Teams client identity documentation](https://github.com/microsoft/teams-sdk/blob/main/teams.md/docs/cli/guides/user-authentication-setup.md).

## Validation

`npm test` runs device-flow and MCP protocol tests without a live sign-in. `sh scripts/build.sh` runs Go tests and builds the reader. `node tests/live-check.mjs` performs explicit read-only smoke checks against the two configured test accounts and prints only counts and chat titles, never message bodies or tokens.

The original FOSS Teams API is pinned to commit `dbbdc3681f32`. Its message service is currently fixed to the library's EMEA endpoint. Other tenants and regions have not been validated. Go dependency licenses are in `third-party/`; JavaScript dependency licenses accompany their installed packages.
