# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### sign in

The Docker image installs Codex CLI inside the container; no Codex CLI is
required on the host. An `account_admin` can sign in or replace the one shared
ChatGPT account from `/admin` using Device Auth. The credential is kept in the
`codex_home` Docker volume, not on the host filesystem.

To pin the CLI version managed by Docker, set `CODEX_VERSION` in `.env` before
building the image.

Do not use plain `codex login` on a remote server: its browser OAuth flow
returns to the CLI callback at `localhost:1455`. Use `/admin` → **Change account
with Device Auth** instead, or run `codex login --device-auth` inside the
container. Device Auth is the supported headless-server flow.

### application authentication

This fork includes an application-level login layer for shared deployments. It
uses local users, signed server-side sessions, and two roles: `member` and
`account_admin`. The first start requires these environment variables:

```bash
CODEX_WEB_AUTH_SECRET="$(openssl rand -base64 48)"
CODEX_WEB_BOOTSTRAP_ADMIN_EMAIL="admin@example.com"
CODEX_WEB_BOOTSTRAP_ADMIN_PASSWORD="use-a-unique-password-with-12-or-more-characters"
CODEX_WEB_PUBLIC_ORIGIN="https://codex.example.com"
```

Sign in at `/login`. An `account_admin` can open `/admin` to add users and
change the single shared ChatGPT account with Device Auth. Account changes are
blocked while browser clients are connected, and each change is recorded in the
local auth database. The database path defaults to
`/var/lib/codex-web/auth.db`; persist that directory in Docker.

Application auth controls the web UI and its API. It does not make the shared
Codex credential safe from a malicious person who can make an agent execute
arbitrary commands in the same container. Use it only with trusted members and
do not grant Docker or SSH access to ordinary members.

### Shared workspace and projects

Mount one server directory as `CODEX_WORKSPACE_PATH`; Docker maps it to
`/workspace` inside the container. The remote-folder picker starts at, and is
restricted to, `CODEX_WORKSPACE_ROOT` (default: `/workspace`). This is
intentional: it prevents the picker from exposing `/home/node/.codex`, which
contains the shared account credential.

Create the project folders on the host before opening the UI, for example:

```bash
mkdir -p /srv/codex-workspace/comic/{assets,outputs,work}
chown -R 1000:1000 /srv/codex-workspace
```

In **Projects** → **Create project** → **Add folders**, select
`/workspace/comic` once and use **Add project** (a double-click only navigates
into a folder). Every signed-in member then opens that same project and works
against the same mounted files. The ChatGPT project is shared application
metadata; it does not copy or create a second filesystem workspace.


When the app is behind a reverse proxy, set `CODEX_WEB_PUBLIC_ORIGIN` to its
exact public HTTPS origin. This allows the IPC WebSocket to validate browser
origins without depending on the proxy's internal `Host` header.

### Docker sandbox mode

Docker is the outer isolation boundary for this deployment. Codex's normal
Linux sandbox uses `bwrap` to create another namespace, but Docker's default
seccomp profile rejects that operation. The resulting error is:

```text
bwrap: No permissions to create a new namespace
```

The image therefore uses `/usr/local/bin/codex-web-cli`, a small wrapper that
sets `sandbox_mode = "danger-full-access"` for the CLI within this already
isolated container. This allows command execution without granting the
container `privileged`, `SYS_ADMIN`, or an unconfined seccomp profile.

`CODEX_WEB_SANDBOX_MODE` defaults to `danger-full-access`; its other valid
values are `workspace-write` and `read-only`. Do not use the default with
untrusted users, mount `/var/run/docker.sock`, or mount sensitive host paths.
The wrapper only affects Codex execution; it does not change Device Auth.

The Docker image keeps the real CLI at `/usr/local/bin/codex` for Device Auth
and configures the extracted Electron shell to use the wrapper. Do not override
`CODEX_CLI_PATH` unless the replacement is executable inside the container.

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

if you need authn or authz, implement it outside of `codex-web`: proxy it through
wireguard, tailscale, or an ssh tunnel and put an authentication gateway or
reverse proxy in front.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

* [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
* the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
* upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
