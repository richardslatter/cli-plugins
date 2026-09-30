# GitHub CLI private cloud plugin

Work in progress. This repository is public source code; the deployed plugin and
GitHub connection must remain private. No GitHub credential is included.

## Verified so far

- A production Sites Worker cannot execute native `gh`: its
  `child_process.spawnSync` throws “method is not implemented”.
- Official GitHub CLI 2.101.0 Linux amd64 release downloaded and verified against
  the release checksums and GitHub's release-asset SHA-256 metadata.
- 30 local Python tests cover read-only routing, validation, account isolation,
  request signatures/replay, bounded subprocesses, encrypted fixture persistence
  across a new process, deletion, and non-interactive fixture login/cancellation.
- Six local MCP gateway tests cover the official SDK's initialization/discovery,
  anonymous/wrong-owner rejection, CSRF, unknown tools and blocked backend state.
- Docker build, Linux service deployment, real hosted GitHub login, persistent
  production credentials, and fresh cloud-chat repository calls remain pending.

These tests do not prove a real GitHub authorization or a deployed native service.
The originally mentioned WIP ZIP was unavailable, so this is a new implementation.

## Architecture

The `gateway/` Worker supplies Sites-managed ChatGPT OAuth and the canonical
private plugin. It accepts trusted platform identity headers only behind the
Sites hosting boundary, checks a preconfigured owner email, and signs short-lived
requests to one Linux service. Never deploy the gateway behind a proxy that lets
callers forge `oai-authenticated-*` headers.

The native service verifies the gateway signature, timestamp, durable replay
nonce, owner and bound Site subject. It runs the official `gh` binary through
fixed argument arrays without a shell. Model-facing tools are all read-only.
GitHub authentication is a separate real `gh auth login` browser/device flow,
bound to `rick-colosl` and the immutable GitHub account ID returned by `gh api`.

Sites is used only for the managed plugin sign-in/connection boundary and minimal
connection controls. The Linux service executes `gh` and owns encrypted state.
Dropping Sites requires provisioning a separate supported MCP OAuth provider;
making the plugin listing private is not endpoint authentication.

## Build and test

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/pytest -q
cd gateway
npm ci --prefix tools
npm run build
npm test
```

The Python tests use fixture credentials and fake CLI login scripts. The backend
production entry point will refuse to start without keys, owner configuration,
the pinned binary, and a Linux tmpfs for CLI configuration.

For the container, on a Linux amd64 Docker builder:

```sh
docker build --platform linux/amd64 -t github-cli-native .
```

`install_gh.py` downloads only the pinned official release and rejects checksum
mismatches. Release provenance is pinned to GitHub's official `cli/cli` release
and checksum metadata. Sigstore attestation verification is not yet completed;
the official verification command required GitHub authentication.

## Deployment

`render.yaml` describes one 512 MB web service in Singapore with a 1 GB durable
disk. It is deployment configuration, not evidence that the service exists.
Render's MCP create-service tool cannot configure Docker, attached disks or
secret files; use the supported Render dashboard/Blueprint for those fields.
Do not start a paid resource without cost approval. At the 2026-09-30 pricing
check, this shape was USD 7/month compute plus USD 0.25/month disk, excluding
tax, workspace charges and usage overages. Confirm pricing before provisioning.

Keep one instance and one Uvicorn worker. SQLite and the live login process are
single-instance state. A redeploy interrupts pending login; start a new login.
Completed encrypted credentials persist on the disk when the separate encryption
key remains available. Verify this with a real redeploy before accepting the service.

Provision independently generated 32-byte base64 keys through the provider's
secret manager as `/etc/secrets/credential-key.b64` and
`/etc/secrets/bridge-key.b64`. Do not paste their values into chat or the repo.
Set `OWNER_EMAIL` to the verified private Site owner, never a tool argument.
Set the same bridge key as the Site secret `BRIDGE_KEY_B64`, and set `BACKEND_URL`
to the actual deployed HTTPS service origin. Leave it unset until verified;
there is deliberately no sample/fake backend URL in a plugin package.

The encryption key is separate from the encrypted SQLite disk. Provider admins
with service/secret access can potentially access credentials. A private plugin
does not make provider administrators unable to inspect its runtime.

`compose.yaml` is a last-resort configuration for an always-on Linux host/NAS.
It still needs authenticated HTTPS cloud reachability, a reverse proxy, protected
secret files, and restart verification. The Mac is not required at runtime.

## Authentication and deletion

Only use the private connection page after all hosted preflight checks pass.
The official CLI requests `repo`, `read:org`, and `gist`, with no extra scopes.
This is a broad OAuth credential; the server's fixed GET tools enforce read-only
access. GitHub SSO, enterprise policy and network restrictions still apply.

The CLI writes plaintext only to a checked memory filesystem under a mode-0700
temporary directory. After account verification, credentials are encrypted with
AES-256-GCM, and the temporary directory is removed. Inherited local credentials,
config, host selection and debug settings are not passed to the CLI.

Disconnect cancels pending login and removes the stored ciphertext, retaining the
immutable owner/account binding. It does not revoke the GitHub CLI grant. Revoking
that grant through GitHub may affect other CLI uses; do not do that as a test.
Provider snapshots can retain old encrypted records until retention expiry.

## Tools and limitations

Tools expose account status, organization membership, authenticated-user repository
enumeration, directory/file reads at resolved commits, code search, issues/comments,
pull requests/reviews/comments/files/diffs, and commits/files.

Repository enumeration uses `/user/repos` with all three affiliations. Follow every
`next_page` and merge by stable repository ID; changing repositories can shift pages.
Memberships and access to organization-owned repositories are different concepts.
Error responses preserve ambiguous 404s, authentication failure, SSO and rate limits.

File reads cap at 512 KiB and 500 lines. Binary content, LFS pointers, submodules,
oversized responses and directory caps are explicit. Search uses GitHub's legacy
code-search API, indexed default branches and the 1000-result cap. No regex or web
search parity is promised. Diff/patch completeness is qualified.

## Required acceptance work

1. Verify hosted native version, tmpfs, HTTPS access and secret-store configuration.
2. Verify endpoint auth, platform OAuth discovery, PKCE, resource/audience binding,
   expiry/refresh and wrong-owner rejection through the actual platform connection.
3. Complete official GitHub authorization as `rick-colosl`, then confirm immutable ID.
4. Enumerate all pages via the plugin and compare with direct `gh api` enumeration
   using the same deployed credential. Do not use a connector or Mac login as proof.
5. Test suitable real directory, file, search, issue, PR and commit data without writes.
6. Restart/redeploy the native service and verify the credential still works.
7. Install/connect the canonical private plugin and call repositories from a new
   cloud chat. Record the result separately from terminal and local fixture tests.

## References

- [GitHub CLI login](https://cli.github.com/manual/gh_auth_login)
- [GitHub CLI API](https://cli.github.com/manual/gh_api)
- [Repository enumeration](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)
- [Plugin authentication](https://developers.openai.com/plugins/build/auth)
- [Sites](https://learn.chatgpt.com/docs/sites)
- [Render disks](https://render.com/docs/disks)
- [Render pricing](https://render.com/pricing)
