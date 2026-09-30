# CLI Plugins

Teams CLI, GitHub CLI and Notion CLI are separate ChatGPT cloud plugins served
by one Render web service. This repository consolidates the original
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
credential namespace and authenticated `get_profile` tool. ChatGPT can list
connected accounts in each plugin's settings and select a connection per chat.
An access token from one app cannot authenticate at another app's endpoint.

## Deployment

Deploy through the official Render CLI and public API after approving hosting
costs. `scripts/render-provision.py` reuses `render login`, checks for an existing
service, and creates the Docker service and disk together without browser
automation. The equivalent root `render.yaml` remains available as IaC. The configuration defines exactly one Docker web service in Singapore and a
1 GB persistent disk. The initial estimate is USD 7.25/month: USD 7 compute plus
USD 0.25 disk, excluding taxes, additional bandwidth and build usage. Confirm
current pricing at <https://render.com/pricing> before applying.

The service needs these private environment variables:

- `TOKEN_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hex characters. Keep a
  protected backup; losing or changing the key makes saved sessions unreadable.
- `TEAMS_ACCOUNTS_JSON`: array of allowed profiles with `id`, `name`,
  `tenantName`, `tenantId`, `loginHint`. Configure real accounts in Render only.
- `GITHUB_ALLOWED_LOGINS`: comma-separated allowed GitHub usernames.

`RENDER_EXTERNAL_URL` supplies the public origin automatically. `PUBLIC_URL` can
explicitly override it for a custom HTTPS origin. Account names and credentials
are never committed. Public landing pages display no saved accounts.

The root deployment does not use Sites. The old GitHub gateway and standalone
configuration under `apps/github-cli` are retained for source continuity;
**do not deploy them**. Start only `node backend/src/server.mjs` with the root
Dockerfile. Authentication is provided directly by this backend.

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

The shared backend is deployed at <https://cli-plugins.onrender.com> on one
Singapore Starter instance (512 MiB, 0.5 CPU) with a 1 GB persistent disk.
The September 30, 2026 deployment passed native startup probes, all three
OAuth discovery/access-gate checks, and an actual service restart. OAuth
clients registered before the restart remained usable afterward. Idle memory
measured approximately 65 MiB; provider workloads still need measurement.

Three separate private cloud plugins have been saved through Plugin Creator.
Their provider sign-ins, native connected-account display and fresh cloud-chat
reads remain acceptance checks. Creating the plugins does not establish those
connections.

To package plugins against this verified backend:

```sh
npm run package-plugins -- https://cli-plugins.onrender.com /path/to/archives
```

This builds three independent portable plugin ZIPs, each pointing to its own
verified endpoint. Save them as private plugins with Plugin Creator, install
and connect each one in ChatGPT, and authorize its provider in your browser.
Sign-in completion alone does not prove a successful cloud tool call.

## Validation

```sh
npm ci --ignore-scripts
npm test
python -m pytest -q tests/test_native.py apps/github-cli/test_backend.py apps/github-cli/test_login.py
cd apps/teams-cli/reader && go test ./...
```

Current local checks: 6 OAuth/MCP/storage integration tests, 42 Python tests
(including the original 30 GitHub tests), and 2 Teams Go tests pass. Dependency
audit: no reported Node vulnerabilities. Native macOS `ntn` version/help and
unauthenticated remote login initialization have been tested. The hosted Linux
backend has passed startup and encrypted client-storage restart checks. Real
provider sign-ins, provider credential survival after restart and fresh
cloud-chat reads remain unverified.

The deployment smoke check uses HTTP requests without browser automation:

```sh
python3 scripts/cloud-smoke.py --origin https://cli-plugins.onrender.com --mode prepare --state-file /private/path/smoke.json
render restart YOUR_SERVICE_ID --confirm
# Wait for a new backend-ready log entry before verifying.
python3 scripts/cloud-smoke.py --origin https://cli-plugins.onrender.com --mode verify --state-file /private/path/smoke.json
```

This check verifies persisted OAuth client metadata. It deliberately does not
claim that any provider account is connected.

## License and provenance

New integration code is MIT licensed. Existing GitHub code/history is retained
from the source repository. Included upstream notices are under
`apps/teams-cli/third-party` and `apps/notion-cli/CLI-LICENSE.md`; provider CLIs
are downloaded at container build time. This is an independent personal
integration, not affiliated with Microsoft, GitHub, Notion or OpenAI.
