# CLI Plugins

Teams CLI, GitHub CLI and Notion CLI are separate ChatGPT cloud plugins served
by one Fly.io app in Sydney (`syd`). This repository consolidates the original
`github-cli-plugin` history with the Teams implementation and official Notion
CLI integration.

## Layout

- `apps/teams-cli`: FOSS Teams Go reader, Microsoft device sign-in, cloud plugin
  source, and the original local default-browser plugin.
- `apps/github-cli`: official `gh` login and reviewed read operations, existing
  tests, cloud plugin source, and the preserved previous implementation.
- `apps/notion-cli`: official `ntn` browser login, read-only wrappers and plugin source.
- `backend`: shared OAuth 2.1/PKCE server, encrypted SQLite vault, browser
  connection pages, MCP transport, and native process bridge.
- `public`: shared connection UI and per-plugin icons.

Each app has its own MCP endpoint at `/apps/<app>/mcp`, OAuth issuer, read scope,
credential namespace and authenticated `get_profile` tool. Once registered as
a ChatGPT cloud app and bound to the plugin, ChatGPT can list connected accounts
in its settings and select a connection per chat.
An access token from one app cannot authenticate at another app's endpoint.

## Deployment

The root `fly.toml` runs one shared-CPU Machine with 512 MiB RAM in Sydney,
with a 1 GB encrypted volume mounted at `/var/data`. Keep exactly one Machine:
the encrypted SQLite vault requires a single writer, and Fly volumes are local
to one Machine. The service stays running for OAuth sign-in flows. Automatic
volume snapshots are retained for five days.

The app is owned by the personal Fly organisation for
`richardslatterdev@gmail.com`. Use the official Fly CLI:

```sh
fly auth whoami
fly apps create cli-plugins --org personal
fly volumes create cli_credentials --app cli-plugins --region syd --size 1
fly secrets import --app cli-plugins < /private/path/fly-secrets.env
fly deploy --remote-only --ha=false
```

Create the app and volume only on first setup. For subsequent releases, run
`fly deploy --remote-only --ha=false` from the repository root. Inspect
`fly status`, `fly checks list`, and `fly logs` to verify the release.
`fly.toml` sets `PUBLIC_URL=https://cli-plugins.fly.dev`; change it together with
the registered MCP endpoints if a custom HTTPS origin is introduced.

The protected secrets file contains these variables, one `NAME=value` per line:

- `TOKEN_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hex characters. Keep a
  protected backup; losing or changing the key makes saved sessions unreadable.
- `TEAMS_ACCOUNTS_JSON`: a JSON array of allowed profiles with `id`, `name`,
  `tenantName`, `tenantId`, and `loginHint`.
- `GITHUB_ALLOWED_LOGINS`: comma-separated allowed GitHub usernames.

Import secrets through stdin; never include their values in command arguments
or commit them. Public landing pages display no saved accounts.
The container initializes ownership of a newly mounted volume, then drops
privileges: the backend and native CLIs run as the `node` user.

The root deployment starts only `node backend/src/server.mjs`. Historical
Render provisioning files are archived under `deploy/legacy/render`; the old
standalone GitHub deployment and Sites gateway under `apps/github-cli` remain
for source continuity. Deploy the root Dockerfile and Fly configuration.

## Native execution and credentials

The container pins Go 1.26.8, Node 22.23.1, GitHub CLI 2.101.0 and Notion CLI
0.23.13. GitHub archive SHA-256 and Notion npm SHA-512 integrity are checked
before installing their native Linux binaries. Startup probes their versions.

Provider credentials are AES-256-GCM encrypted in SQLite on the persistent disk.
GitHub and Notion sign-in configuration is created only on verified Linux tmpfs
(`/dev/shm`), then encrypted and removed. Requests use private child-process
environments, fixed executable paths, reviewed arguments, output limits and
timeouts. Teams tokens enter its native reader on stdin. Tokens are not placed
in shell commands, browser URLs or service logs.

Upstream credentials can permit writes. The MCP server enforces read-only
command allowlists. Notion's two POST endpoints are read operations: title
search and data-source queries. No arbitrary CLI, API path, mutation, worker
deployment or shell tool is exposed.

Microsoft sign-in uses the Teams desktop public-client identity. Teams reads
use the unofficial FOSS Teams library; organisation policy can block sign-in.
Notion CLI requires full membership of the selected workspace; guests and
restricted members cannot authorize it.

## Cloud plugins

The shared backend is hosted at <https://cli-plugins.fly.dev>. The three
private plugin packages keep their existing identities and bind to replacement
Fly cloud app registrations.
A plugin package's website URL does not change the cloud app's MCP endpoint;
create replacement development registrations for the Fly origin, then package
their verified app IDs. The previous Render registrations remain available for
reference; their provider sessions cannot be used on Fly.

The previous Render service was unavailable during migration, so its live
SQLite database could not be exported. The protected encryption-key backup and
allowed Teams profiles were retained. Provider accounts must reconnect on Fly;
stale Render OAuth credentials cannot authenticate at the new issuer.

Register each endpoint in ChatGPT developer mode. Open Settings → Security and
login → Developer mode, then Plugins → plus button. Use OAuth with dynamic
client registration (DCR); this server advertises its registration endpoint and
uses public-client PKCE. The endpoint supplies authorization/token discovery.
If the client offers a registration-method choice, choose DCR.

| Name | MCP endpoint | Read scope |
| --- | --- | --- |
| Teams CLI | `https://cli-plugins.fly.dev/apps/teams-cli/mcp` | `teams.read` |
| GitHub CLI | `https://cli-plugins.fly.dev/apps/github-cli/mcp` | `github.read` |
| Notion CLI | `https://cli-plugins.fly.dev/apps/notion-cli/mcp` | `notion.read` |

Record the actual registered app ID and its verified endpoint for each app in a
protected binding file. Do not invent IDs or bind the existing unrelated
Microsoft Teams, GitHub or Notion connectors. The packaging script consumes a
JSON object keyed by `teams-cli`, `github-cli` and `notion-cli`, with `id` and
`endpoint` fields on each value. Keep IDs exactly as supplied by the platform.

Then package the cloud plugin updates:

```sh
npm run package-plugins -- https://cli-plugins.fly.dev /path/to/archives --cloud-apps /private/path/verified-bindings.json
```

This builds three independent plugin ZIPs with required registered app mappings
in `.app.json`, synchronized root and compatibility manifests, and empty raw
MCP declarations to replace the old desktop connections. Update the existing
private plugins with a release guard; preserve their identities and audience.
After installation, verify provider sign-in, account labels and an actual cloud
tool call. Sign-in completion alone does not prove a successful cloud tool call.

Portable MCP clients can explicitly request `--portable` instead. Those packages
are separate desktop artifacts, not completed ChatGPT cloud app registrations.
See [OpenAI's packaging guide](https://developers.openai.com/plugins/build/plugins)
and [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Validation

```sh
npm ci --ignore-scripts
npm test
python -m pytest -q tests/test_native.py apps/github-cli/test_backend.py apps/github-cli/test_login.py
cd apps/teams-cli/reader && go test ./...
```

Local checks: 6 OAuth/MCP/storage integration tests, 42 Python tests
(including the original 30 GitHub tests), and 2 Teams Go tests pass. Dependency
audit: no reported Node vulnerabilities. Native macOS `ntn` version/help and
unauthenticated remote login initialization have been tested. The September 30,
2026 Fly deployment passed native startup probes, discovery and anonymous access
gates for all three apps, and persisted OAuth client checks after an actual
Machine restart. The backend runs as `node` on a private volume directory
(mode 700) with a private vault file (mode 600). Provider sign-ins, provider credential survival after
restart and fresh cloud-chat reads must be verified separately.

The deployment smoke check uses HTTP requests without browser automation:

```sh
python3 scripts/cloud-smoke.py --origin https://cli-plugins.fly.dev --mode prepare --state-file /private/path/smoke.json
fly apps restart cli-plugins
# Wait for a new backend-ready log entry before verifying.
python3 scripts/cloud-smoke.py --origin https://cli-plugins.fly.dev --mode verify --state-file /private/path/smoke.json
```

This check verifies persisted OAuth client metadata. It deliberately does not
claim that any provider account is connected.

## License and provenance

New integration code is MIT licensed. Existing GitHub code/history is retained
from the source repository. Included upstream notices are under
`apps/teams-cli/third-party` and `apps/notion-cli/CLI-LICENSE.md`; provider CLIs
are downloaded at container build time. This is an independent personal
integration, not affiliated with Microsoft, GitHub, Notion or OpenAI.
