# FetchBot

*A self-hostable Discord bot: panel-managed commands, reaction roles, and optional
Twitch go-live notifications.*

*Deutsche Version: [README.de.md](README.de.md)*

A small Discord bot with a browser admin panel:

- **Text slash-commands** — create/edit/delete them in the panel; each picks a random
  reply and can optionally target a `@user`. No redeploy, no editing files by hand.
- **Reaction roles** ("Rollenverteilung") — post a message with several emoji→role
  mappings; reacting grants the role, un-reacting removes it. Multiple independent
  distributors, each with a live embed preview in the panel.
- **Admin panel** — session login, brute-force limiter, CSRF protection, all behind
  a single password. Easy to extend with new modules.
- **Optional Twitch go-live notifications** — a `/live` command and a `/notify` HTTP
  endpoint that posts a rich embed when your stream starts (driven by an external
  poller such as n8n). Fully optional: leave the Twitch variables unset and the bot
  is a pure commands + reaction-role bot.
- **White-label** — name, icon and accent color come from config; nothing is
  hardwired to a specific brand.
- **Docker-first** — one `docker compose up`, runs unprivileged, ships a healthcheck.

> The code comments are German; this README is the English reference. Runtime
> user-facing strings default to German and are overridable via env (see below).

## Features at a glance

| Feature | Needs |
| --- | --- |
| Text slash-commands + admin panel | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ADMIN_PASSWORD` |
| Reaction roles | above + **Server Members Intent** + `Manage Roles` |
| Twitch `/live` command | above + `TWITCH_CLIENT_ID/SECRET/LOGIN` |
| Twitch go-live post (`/notify`) | above + `DISCORD_CHANNEL_ID` + an external poller (e.g. n8n) |

## Quick start

```bash
git clone <your-fork-url> bot && cd bot
cp .env.example .env
# edit .env — at minimum set DISCORD_BOT_TOKEN (see "Discord setup" below)
docker compose up -d --build
docker compose logs -f
```

The `data/` volume (holding `commands.json` and `settings.json`) is created and
chowned by the container on first start — you don't need to create it by hand.

> **Upgrading a deployment that used a different compose service/container name?**
> Run once with `docker compose up -d --build --remove-orphans` (or
> `docker rm -f <old-container>` first) so the previous container releases the ports.
> The `./data` bind mount is preserved regardless of the container name.

## Discord setup

1. Create an application in the **Discord Developer Portal**, add a **Bot**, and copy
   its token into `DISCORD_BOT_TOKEN`.
2. Set the bot's **name and avatar in the Portal** — they are not in code.
3. Under **Bot → Privileged Gateway Intents**, enable the **Server Members Intent**
   (required for reaction roles). *Message Content Intent is not needed.*
4. Under **OAuth2 → URL Generator**, pick scopes `bot` **and** `applications.commands`,
   and permissions `Send Messages`, `Embed Links`, `Add Reactions`, `Manage Roles`.
   Invite the bot with the generated URL.
5. In your server, drag the **bot's role above** every role a reaction-role
   distributor should hand out — Discord only lets a bot assign roles below its own.

> **Missing the Server Members Intent** makes the login fail (`Used disallowed
> intents`) and the container crash-loops. **Missing `applications.commands`** silently
> hides all slash commands — if the bot was invited with only `bot`, re-invite it with
> both scopes (it keeps its token, name and avatar).

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example) for
the annotated list. The essentials:

| Variable | Meaning |
| --- | --- |
| `DISCORD_BOT_TOKEN` | **Required.** Bot token from the Developer Portal. |
| `DISCORD_GUILD_ID` | Strongly recommended — without it no slash commands register. |
| `BRAND_NAME` / `BRAND_EMOJI` | Panel title & icon (white-label). Name empty = live bot name. |
| `EMBED_COLOR` | Accent color of all embeds (hex, e.g. `#5865f2`). |
| `ADMIN_PASSWORD` | Empty = panel off; set = panel on. |
| `ADMIN_PORT` / `ADMIN_BIND` | Panel port and bind address (default `127.0.0.1`). |
| `ADMIN_TRUST_PROXY` | Set to `1` only when behind a reverse proxy. |
| `DISCORD_CHANNEL_ID` | Target channel for the go-live post (only for `/notify`). |
| `MENTION_ROLE_ID` | Start default for the go-live mention (empty / `everyone` / role ID). |
| `TWITCH_CLIENT_ID/SECRET/LOGIN` | Only for `/live`; all three or none. |
| `NOTIFY_TOKEN` | If set, `/notify` requires header `X-Notify-Token`. |
| `HTTP_PORT` | Internal notify/health port (also drives the compose port mapping). |
| `BOT_CONTAINER_NAME` | Container name (compose); rename to run several instances. |

## Admin panel

Set `ADMIN_PASSWORD` to enable a small web panel where you manage commands, reaction
roles and the go-live mention. Every change is saved immediately and (for commands)
re-registered with Discord.

Login is a password form; the session lives in an `HttpOnly` cookie (7 days,
`SameSite=Strict`), with a logout button and a per-IP lockout after five failed
attempts. **Reaching it** — the panel binds to `127.0.0.1` by default:

- **SSH tunnel** (recommended): `ssh -L 7855:localhost:7855 user@server`, then open
  `http://localhost:7855`.
- **LAN**: set `ADMIN_BIND` to the server's LAN IP. Strong password only.
- **Domain via reverse proxy**: keep the bind on `127.0.0.1`, point the proxy at it,
  terminate **TLS at the proxy**, and set `ADMIN_TRUST_PROXY=1`. Also forward
  `X-Forwarded-Proto: https` so the session cookie gets the `Secure` flag. Use a
  subdomain, not a sub-path (the panel loads its API from root paths `/api/...`).

New modules plug in via the `MODULES` block in `public/admin.html` (frontend) and a
router under `/api/<module>` in `admin.js` (backend); auth and CSRF then apply
automatically.

## Text slash-commands

`commands.json` lives in the mounted `data/` directory (outside the image). Manage it
in the panel, or edit it directly and `docker compose restart`. Format:

```json
{
  "hello": {
    "description": "Says hello.",
    "replies": ["Hi there! 👋", "Hey!"]
  },
  "high5": {
    "description": "High-five someone.",
    "target": true,
    "replies": ["✋ high five, {ziel}!"]
  }
}
```

One reply is picked at random. Set `"target": true` and put `{ziel}` in the replies to
require a `@user` argument that gets mentioned. `@everyone`/`@here` are always stripped.
The bundled default is a tiny neutral set; a playful German dog-mascot example lives in
[`examples/commands.dog.json`](examples/commands.dog.json).

## Reaction roles

In the panel under **Rollenverteilung** you create *distributors*. A distributor is one
message with several **emoji→role** mappings: the bot posts an embed, reacts with each
emoji, and reacting grants the mapped role (un-reacting removes it). Configure a name,
channel, title, description (Markdown) and the emoji→role list; the editor shows a live
preview. Requirements: the **Server Members Intent** and a bot role above every role it
hands out.

## Optional: Twitch go-live notifications

Two independent pieces, both optional:

- **`/live`** — set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_LOGIN` and the
  bot queries the Twitch Helix API on demand. Missing any → the command is omitted.
- **`/notify`** — an HTTP endpoint (`POST`) that, given `{ streamer, url, ... }`, posts
  a go-live embed to `DISCORD_CHANNEL_ID` with the mention configured in the panel.
  Meant to be called by an external poller.

A typical **n8n** recipe: `Schedule (60s)` → `Twitch Helix /streams` → `Remove
Duplicates` (on the stream ID, so each stream pings once) → `Twitch Helix /users` →
`HTTP POST` to the bot's `/notify`. The bot only posts; all polling logic lives in your
workflow. Point the POST at the bot via the Docker gateway
(`http://172.17.0.1:${HTTP_PORT}/notify`) — see the compose comments for why the
endpoint binds there and not to `0.0.0.0`.

`POST /notify` body — `streamer` and `url` required, rest optional:

```json
{ "streamer": "streamername", "title": "...", "game": "...",
  "url": "https://twitch.tv/streamername",
  "thumbnailUrl": "...", "profileImageUrl": "..." }
```

Responses: `200` sent · `400` missing field · `503` bot not ready / no channel
configured · `500` Discord error.

## White-label / branding

Nothing is hardwired to a specific brand:

- **Name & avatar** come from the Discord Developer Portal.
- **`BRAND_NAME`, `BRAND_EMOJI`, `EMBED_COLOR`** style the panel and embeds.
- **Runtime strings** default to German; override the visible Twitch/live strings via
  `LIVE_EMBED_TEXT`, `LIVE_BUTTON_LABEL`, `LIVE_OFFLINE_MESSAGE`, `LIVE_ERROR_MESSAGE`
  (`{streamer}` placeholder). Command and reaction-role text is fully panel-managed.
- The default `commands.json` is a neutral starter set.

## Security notes

- The `/notify` endpoint has no auth by design and is bound to the Docker gateway only;
  set `NOTIFY_TOKEN` if you expose it more widely.
- Never commit your `.env` — it is git-ignored, and `.env.example` holds only placeholders.
- Put TLS in front of the admin panel for any non-localhost access.

## License

[MIT](LICENSE).
