# FetchBot

*Ein selbst-hostbarer Discord-Bot: Panel-verwaltete Befehle, Reaction-Roles und
optionale Twitch-Live-Benachrichtigungen.*

*English version: [README.md](README.md)*

Ein kleiner Discord-Bot mit Browser-Admin-Panel:

- **Text-Slash-Befehle** — im Panel anlegen/bearbeiten/löschen; jeder wählt eine
  zufällige Antwort und kann optional ein `@user`-Ziel ansprechen. Kein Redeploy,
  kein Datei-Editieren von Hand.
- **Reaction-Roles** („Rollenverteilung") — eine Nachricht mit mehreren
  Emoji→Rolle-Zuordnungen; Reagieren vergibt die Rolle, Entfernen nimmt sie weg.
  Beliebig viele Verteiler, jeder mit Live-Vorschau des Embeds im Panel.
- **Admin-Panel** — Session-Login, Brute-Force-Bremse, CSRF-Schutz, alles hinter einem
  Passwort. Leicht um neue Module erweiterbar.
- **Optionale Twitch-Live-Benachrichtigungen** — ein `/live`-Befehl und ein
  `/notify`-HTTP-Endpoint, der beim Stream-Start ein Rich-Embed postet (angetrieben von
  einem externen Poller wie n8n). Komplett optional: ohne die Twitch-Werte ist es ein
  reiner Befehls- + Reaction-Role-Bot.
- **White-label** — Name, Icon und Akzentfarbe kommen aus der Config; nichts ist auf
  eine bestimmte Marke festgenagelt.
- **Docker-first** — ein `docker compose up`, läuft unprivilegiert, bringt einen
  Healthcheck mit.

## Features auf einen Blick

| Feature | Braucht |
| --- | --- |
| Text-Befehle + Admin-Panel | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `ADMIN_PASSWORD` |
| Reaction-Roles | dazu **Server Members Intent** + `Manage Roles` |
| Twitch-`/live`-Befehl | dazu `TWITCH_CLIENT_ID/SECRET/LOGIN` |
| Twitch-Live-Post (`/notify`) | dazu `DISCORD_CHANNEL_ID` + externer Poller (z.B. n8n) |
| Chat-Brücke Twitch ↔ Discord | `/live`-Werte + `TWITCH_REDIRECT_URI` + Panel + **Message Content Intent** + Twitch-Bot-Account |

## Schnellstart

```bash
git clone <deine-fork-url> bot && cd bot
cp .env.example .env
# .env bearbeiten — mindestens DISCORD_BOT_TOKEN setzen (siehe "Discord-Setup")
docker compose up -d --build
docker compose logs -f
```

Das `data/`-Volume (für `commands.json` und `settings.json`) legt der Container beim
ersten Start selbst an und setzt die Rechte — du musst es **nicht** von Hand erstellen.

> **Upgrade eines Deployments mit altem compose-Service-/Container-Namen?** Einmal mit
> `docker compose up -d --build --remove-orphans` starten (oder vorher
> `docker rm -f <alter-container>`), damit der alte Container die Ports freigibt. Der
> `./data`-Bind-Mount bleibt unabhängig vom Container-Namen erhalten.

## Discord-Setup

1. Im **Discord Developer Portal** eine Application anlegen, einen **Bot** hinzufügen,
   den Token in `DISCORD_BOT_TOKEN` kopieren.
2. **Name und Avatar des Bots im Portal** setzen — nicht im Code.
3. Unter **Bot → Privileged Gateway Intents** den **Server Members Intent** aktivieren
   (Pflicht für Reaction-Roles). Den **Message Content Intent** braucht nur die
   [Chat-Brücke](#optional-chat-brücke-twitch--discord).
4. Unter **OAuth2 → URL Generator** Scopes `bot` **und** `applications.commands` wählen,
   Permissions `Send Messages`, `Embed Links`, `Add Reactions`, `Manage Roles`. Mit der
   erzeugten URL den Bot einladen.
5. Im Server die **Bot-Rolle über** jede Rolle ziehen, die ein Verteiler vergeben soll —
   Discord lässt einen Bot nur Rollen unter seiner eigenen höchsten vergeben.

> **Fehlender Server Members Intent** lässt den Login scheitern (`Used disallowed
> intents`), der Container crash-loopt. **Fehlender `applications.commands`-Scope**
> versteckt alle Slash-Befehle lautlos — war der Bot nur mit `bot` eingeladen, mit
> beiden Scopes neu autorisieren (Token, Name, Avatar bleiben).

## Konfiguration

Alles über Umgebungsvariablen — die kommentierte Liste steht in
[`.env.example`](.env.example). Das Wichtigste:

| Variable | Bedeutung |
| --- | --- |
| `DISCORD_BOT_TOKEN` | **Pflicht.** Token aus dem Developer Portal. |
| `DISCORD_GUILD_ID` | Dringend empfohlen — ohne registrieren sich keine Befehle. |
| `BRAND_NAME` / `BRAND_EMOJI` | Panel-Titel & -Icon (white-label). Name leer = Bot-Name. |
| `EMBED_COLOR` | Akzentfarbe aller Embeds (Hex, z.B. `#5865f2`). |
| `ADMIN_PASSWORD` | Leer = Panel aus; gesetzt = Panel an. |
| `ADMIN_PORT` / `ADMIN_BIND` | Panel-Port und Bind-Adresse (Default `127.0.0.1`). |
| `ADMIN_TRUST_PROXY` | Nur hinter Reverse Proxy auf `1` setzen. |
| `DISCORD_CHANNEL_ID` | Ziel-Channel des Live-Posts (nur für `/notify`). |
| `MENTION_ROLE_ID` | Start-Default der Live-Mention (leer / `everyone` / Rollen-ID). |
| `TWITCH_CLIENT_ID/SECRET/LOGIN` | Für `/live` und die Chat-Brücke; alle drei oder keiner. |
| `TWITCH_REDIRECT_URI` | Schaltet die Chat-Brücke frei (OAuth-Rücksprung des Panels, z.B. `https://bot.example.de/twitch/callback`). |
| `NOTIFY_TOKEN` | Gesetzt = `/notify` verlangt Header `X-Notify-Token`. |
| `HTTP_PORT` | Interner Notify-/Health-Port (steuert auch das Port-Mapping). |
| `BOT_CONTAINER_NAME` | Container-Name (compose); umbenennen für mehrere Instanzen. |

## Admin-Panel

Mit gesetztem `ADMIN_PASSWORD` läuft ein Web-Panel, in dem du Befehle, Reaction-Roles
und die Live-Mention verwaltest. Jede Änderung wird sofort gespeichert und (bei Befehlen)
neu bei Discord registriert.

Der Login läuft über eine Passwort-Maske; die Session steckt in einem `HttpOnly`-Cookie
(7 Tage, `SameSite=Strict`), Abmelden per Knopf, nach fünf Fehlversuchen IP-Sperre für
eine Minute. **Zugriff** — das Panel bindet standardmäßig an `127.0.0.1`:

- **SSH-Tunnel** (empfohlen): `ssh -L 7855:localhost:7855 user@server`, dann
  `http://localhost:7855`.
- **LAN**: `ADMIN_BIND` auf die LAN-IP des Servers setzen. Nur mit starkem Passwort.
- **Domain über Reverse Proxy**: Bind auf `127.0.0.1` lassen, Proxy davor, **TLS am
  Proxy** terminieren, `ADMIN_TRUST_PROXY=1` setzen. Zusätzlich
  `X-Forwarded-Proto: https` durchreichen, damit das Cookie das `Secure`-Flag bekommt.
  Subdomain nehmen, keinen Unterpfad (das Panel lädt seine API über `/api/...`).

Neue Module docken über den `MODULES`-Block in `public/admin.html` (Frontend) und einen
Router unter `/api/<modul>` in `admin.js` (Backend) an — Auth und CSRF gelten dann
automatisch.

## Text-Slash-Befehle

`commands.json` liegt im gemounteten `data/`-Verzeichnis (außerhalb des Images).
Verwalte sie im Panel oder editiere direkt und `docker compose restart`. Format:

```json
{
  "hallo": {
    "description": "Sagt Hallo.",
    "replies": ["Hallo! 👋", "Hey!"]
  },
  "high5": {
    "description": "Gib jemandem ein High Five.",
    "target": true,
    "replies": ["✋ High five, {ziel}!"]
  }
}
```

Eine Antwort wird zufällig gewählt. Mit `"target": true` und `{ziel}` in den Antworten
verlangt der Befehl ein `@user`-Ziel, das erwähnt wird. `@everyone`/`@here` werden immer
herausgefiltert. Der mitgelieferte Default ist ein kleines neutrales Set; ein
verspieltes Hunde-Maskottchen-Beispiel liegt in
[`examples/commands.dog.json`](examples/commands.dog.json).

## Reaction-Roles

Im Panel unter **Rollenverteilung** legst du *Verteiler* an. Ein Verteiler ist eine
Nachricht mit mehreren **Emoji→Rolle**-Zuordnungen: Der Bot postet ein Embed, reagiert
mit jedem Emoji, und Reagieren vergibt die zugeordnete Rolle (Entfernen nimmt sie weg).
Konfiguriert werden Name, Kanal, Titel, Text (Markdown) und die Emoji→Rolle-Liste; der
Editor zeigt eine Live-Vorschau. Voraussetzungen: der **Server Members Intent** und eine
Bot-Rolle über jeder vergebenen Rolle.

## Optional: Twitch-Live-Benachrichtigungen

Zwei unabhängige, jeweils optionale Teile:

- **`/live`** — mit `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_LOGIN` fragt der
  Bot die Twitch-Helix-API bei Bedarf ab. Fehlt einer → der Befehl entfällt.
- **`/notify`** — ein HTTP-Endpoint (`POST`), der aus `{ streamer, url, ... }` ein
  Live-Embed in `DISCORD_CHANNEL_ID` postet, mit der im Panel gesetzten Mention. Gedacht
  für einen externen Poller.

Ein typisches **n8n**-Rezept: `Schedule (60s)` → `Twitch Helix /streams` → `Remove
Duplicates` (auf die Stream-ID, damit jeder Stream genau einmal pingt) → `Twitch Helix
/users` → `HTTP POST` an `/notify`. Der Bot postet nur; die Poll-Logik lebt im Workflow.
Den POST über das Docker-Gateway ansprechen
(`http://172.17.0.1:${HTTP_PORT}/notify`) — warum der Endpoint dorthin bindet und nicht
an `0.0.0.0`, steht in den compose-Kommentaren.

`POST /notify`-Body — `streamer` und `url` Pflicht, Rest optional:

```json
{ "streamer": "streamername", "title": "...", "game": "...",
  "url": "https://twitch.tv/streamername",
  "thumbnailUrl": "...", "profileImageUrl": "..." }
```

Antworten: `200` gesendet · `400` Pflichtfeld fehlt · `503` Bot nicht bereit / kein Kanal
konfiguriert · `500` Discord-Fehler.

## Optional: Chat-Brücke Twitch ↔ Discord

Verbindet den Twitch-Chat von `TWITCH_LOGIN` mit **einem** Discord-Kanal, in beide
Richtungen. Welcher Kanal, und ob die Brücke läuft, stellst du im Panel unter
**Chat-Brücke** ein.

| Wo | Wie die Nachricht erscheint |
| --- | --- |
| Discord | Webhook-Nachricht mit Twitch-Name und -Avatar: **viewer123 (Twitch)** `APP` |
| Twitch | vom Bot-Account: `meinbot: Lena (Discord): ist wer da?` |

Auf Twitch kann niemand unter fremdem Namen schreiben, deshalb kommt dort alles von einem
eigenen Bot-Account mit dem Discord-Namen vorneweg.

### Einrichtung

1. **Twitch-Bot-Account** (nicht der Streamer), Mail bestätigt. Am besten **Mod** im Kanal
   (`/mod meinbot`, durch Streamer oder Lead-Mod): höheres Sendelimit, Slow-/Follower-Mode
   bremsen nicht, gelöschte Discord-Nachrichten verschwinden auch auf Twitch.
2. **Twitch-App** (dieselbe wie für `/live`, [Developer Console](https://dev.twitch.tv/console/apps)):
   unter *OAuth Redirect URLs* die Rücksprung-Adresse eintragen, z.B.
   `https://bot.example.de/twitch/callback`.
3. **`.env`**: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_LOGIN`, `ADMIN_PASSWORD` und
   `TWITCH_REDIRECT_URI` (exakt wie in Schritt 2). Die URL muss aufs **Panel** zeigen (gleiche
   Domain); der Pfad ist frei, aber nicht `/`, `/login` oder `/api/...`.
4. **Discord Developer Portal → Bot → Privileged Gateway Intents**: den **Message Content
   Intent** einschalten. *Sobald `TWITCH_REDIRECT_URI` gesetzt ist, fordert der Bot ihn an —
   ist er aus, scheitert der Login (`Used disallowed intents`) und der Container startet nicht.*
5. **Kanal-Rechte** der Bot-Rolle: Kanal ansehen, Nachrichten senden, Webhooks verwalten,
   Reaktionen hinzufügen, Nachrichtenverlauf lesen. Das Panel zeigt, was fehlt.
6. Neu bauen: `docker compose up -d --build`.
7. Panel → **Chat-Brücke** → **Mit Twitch verbinden**. Twitch zeigt an, als wer du angemeldet
   bist — das muss der **Bot-Account** sein (sonst „Nicht du?").
8. Kanal wählen, **Brücke aktiv** anhaken, speichern. Erst im Test-Kanal probieren; der
   Kanalwechsel braucht keinen Neustart.

Der Bot legt im Kanal einen Webhook „`BRAND_NAME` Chat-Brücke" an. Das Token des
Bot-Accounts liegt in `data/twitch-bridge-token.json` (Rechte 600), erneuert sich selbst und
wird bei **Trennen** widerrufen. Rechte: `user:read:chat`, `user:write:chat`,
`user:read:moderated_channels`, `moderator:manage:chat_messages`.

### Verhalten

- **Nur Text.** Bilder, GIFs, Sticker und Anhänge werden nicht übertragen.
- Lange Discord-Nachrichten werden in 500-Zeichen-Teile aufgeteilt (max. 5, jeder mit
  Namens-Präfix). Zeilenumbrüche → Leerzeichen, Server-Emojis → `:name:`, Spoiler → `[Spoiler]`.
- Twitch-Markdown wird in Discord entschärft (keine getarnten Links), Link-Vorschauen sind
  aus. `@everyone`, `@here` und Rollen pingen nie.
- `@Name` auf Twitch pingt eine Discord-Person nur, wenn sie in den letzten 2 Stunden im
  Brücken-Kanal geschrieben hat. Echte Twitch-Erwähnungen (`@twitchuser`) pingen in Discord nie.
- Antworten bleiben erhalten: Eine Discord-Antwort auf eine gespiegelte Nachricht wird eine
  echte Twitch-Antwort, eine Twitch-Antwort auf eine Brücken-Nachricht erwähnt die Discord-Person.
- Kein Echo: Bot-Nachrichten auf Twitch und Webhook-/Bot-Nachrichten in Discord werden nie
  zurückgespiegelt. Im Shared Chat wird nur der eigene Kanal gespiegelt.

### Moderation

| Passiert | Folge |
| --- | --- |
| Twitch-Mod löscht eine Nachricht | Discord-Kopie wird gelöscht |
| Ban / Timeout auf Twitch | Discord-Kopien der Person (seit Start) werden gelöscht |
| Discord-Nachricht gelöscht | Twitch-Kopie wird gelöscht — nur wenn der Bot Mod ist |
| Discord-Mod löscht eine gespiegelte Twitch-Nachricht | nur in Discord weg |
| Twitch verwirft die Nachricht (AutoMod, Sperrbegriffe, Slow-Mode …) | 🚫-Reaktion in Discord |
| Brücke konnte nicht senden (Warteschlange voll, Fehler) | ⚠️-Reaktion in Discord |

Twitch-Bans gelten nicht in Discord — dort moderieren die Discord-Mods. Bearbeitungen und
ein komplettes `/clear` werden nicht gespiegelt. Die Nachrichten-Zuordnung liegt nur im
Speicher; nach einem Neustart lassen sich ältere Nachrichten nicht mehr synchron löschen.
Log-Präfixe: `[brücke]` und `[twitch-auth]`; das Panel zeigt Verbindung, Zähler und letzten
Fehler.

## Tests

```bash
npm install && npm test
```

Testet die Text-Umwandlung der Brücke, den Twitch-Login und den kompletten Brücken-Ablauf
gegen ein simuliertes Twitch und Discord (ohne Netzwerk) sowie die Brücken-API des Panels.

## White-label / Branding

Nichts ist auf eine bestimmte Marke festgelegt:

- **Name & Avatar** kommen aus dem Discord Developer Portal.
- **`BRAND_NAME`, `BRAND_EMOJI`, `EMBED_COLOR`** gestalten Panel und Embeds.
- **Laufzeit-Strings** sind standardmäßig deutsch; die sichtbaren Twitch-/Live-Texte
  überschreibst du mit `LIVE_EMBED_TEXT`, `LIVE_BUTTON_LABEL`, `LIVE_OFFLINE_MESSAGE`,
  `LIVE_ERROR_MESSAGE` (`{streamer}`-Platzhalter). Befehls- und Reaction-Role-Texte sind
  komplett im Panel verwaltet.
- Die Default-`commands.json` ist ein neutrales Starter-Set.

## Sicherheits-Hinweise

- Der `/notify`-Endpoint hat bewusst keine Auth und bindet nur ans Docker-Gateway; setze
  `NOTIFY_TOKEN`, wenn du ihn weiter öffnest.
- Niemals die `.env` committen — sie ist git-ignoriert, `.env.example` enthält nur
  Platzhalter.
- Vor das Admin-Panel gehört bei jedem Nicht-localhost-Zugriff TLS.

## Lizenz

[MIT](LICENSE).
