# Security policy

Wrangl handles API credentials and makes requests on an agent's behalf, so
security reports are taken seriously.

## Supported versions

Wrangl is pre-1.0. Security fixes go into the latest release only, so
please check that an issue still reproduces on the newest version before
reporting it.

## Reporting a vulnerability

**Please don't report security issues in public GitHub issues.**

Report them privately through GitHub instead:
[report a vulnerability](https://github.com/asgerami/wrangl/security/advisories/new).
Please include:

- The Wrangl version, and how you run it (CLI, `wrangl serve`, Docker, or
  as a library)
- Steps to reproduce, or a proof of concept
- What an attacker could do with it

Confirmed issues are fixed privately and released before they're disclosed.
Reporters are credited in the published advisory unless they'd rather not
be.

## What's in scope

Reports are especially welcome for:

- Credentials reaching the agent, the logs, or any host other than the
  upstream API
- Tool calls reaching endpoints or hosts they shouldn't
- Ways around the admin token, the per-server MCP token, or the
  destructive-action confirmation

Vulnerabilities in the upstream APIs that Wrangl calls are out of scope;
report those to the API's provider. For hardening a deployment, see
[Securing a deployment](docs/GUIDE.md#securing-a-deployment).
