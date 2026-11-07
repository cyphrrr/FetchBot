// Admin-Panel: eigener HTTP-Server auf eigenem Port, komplett getrennt vom
// n8n-Endpoint. Alles hier liegt hinter Basic Auth.
//
// Neue Funktionen andocken: einen Router bauen und in createAdminServer()
// unter /api/<modul> mounten — Auth und CSRF-Schutz gelten dann automatisch.
// Frontend-Seite dazu: public/admin.html, Abschnitt "MODULE".
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateEntry, normalizeEntry, safeEqual, RULES } from './store.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

/** Fehler mit HTTP-Status, damit ein Mutator 404/409/400 signalisieren kann. */
function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

// --- Brute-Force-Bremse: pro IP zählen, nach zu vielen Fehlversuchen sperren. ---
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

function makeLimiter() {
  const state = new Map(); // ip -> { fails, until, seenUntil }
  let lastPrune = 0;

  // Ohne Aufräumen würde die Map über das öffentliche /api/login unbegrenzt
  // wachsen (jede fehlschlagende IP ein Dauer-Eintrag) → Speicher-DoS. Darum
  // Einträge verwerfen, die weder gesperrt sind (until) noch kürzlich einen
  // Fehlversuch hatten (seenUntil). Höchstens ~1x/Sekunde, damit das auch bei
  // vielen Requests billig bleibt statt O(n) pro Aufruf.
  function maybePrune(now) {
    if (now - lastPrune < 1000) return;
    lastPrune = now;
    for (const [ip, e] of state) {
      if (e.until <= now && e.seenUntil <= now) state.delete(ip);
    }
  }

  return {
    locked(ip) {
      const e = state.get(ip);
      return Boolean(e && e.until > Date.now());
    },
    fail(ip) {
      const now = Date.now();
      maybePrune(now);
      const e = state.get(ip) ?? { fails: 0, until: 0, seenUntil: 0 };
      e.fails += 1;
      // Zähler verfällt nach LOCK_MS Inaktivität (rollierendes Fenster) und
      // macht den Eintrag danach löschbar.
      e.seenUntil = now + LOCK_MS;
      if (e.fails >= MAX_FAILS) {
        e.until = now + LOCK_MS;
        e.fails = 0;
      }
      state.set(ip, e);
    },
    ok(ip) {
      state.delete(ip);
    },
  };
}

// --- Session-Cookies: Login legt eine an, jede weitere Anfrage weist sie vor. ---
const COOKIE = 'bot_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

/** Cookie-Header ohne Extra-Abhängigkeit in ein Objekt zerlegen. */
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Neues Session-Token anlegen und dabei abgelaufene aufräumen. */
function newSession(sessions) {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
  const token = randomBytes(32).toString('hex'); // 256 Bit, nicht erratbar
  sessions.set(token, now + SESSION_TTL_MS);
  return token;
}

/** true, wenn die Anfrage ein gültiges, nicht abgelaufenes Session-Cookie trägt. */
function hasValidSession(sessions, req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/**
 * Session-Cookie setzen. Secure nur, wenn die Verbindung als HTTPS erkannt wird
 * — hinter dem Proxy setzt das voraus, dass er X-Forwarded-Proto: https schickt
 * (bei direktem localhost-Zugriff ohne TLS bliebe das Cookie sonst unbrauchbar).
 */
function setSessionCookie(res, req, token) {
  const attrs = [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (req.secure) attrs.push('Secure');
  res.set('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Kleine Ergebnisseite nach dem Twitch-Login. Bewusst eine eigene Seite statt
 * Redirect: Twitch ruft uns seitenübergreifend auf, dabei schickt der Browser das
 * SameSite=Strict-Session-Cookie nicht mit — ein direkter Redirect ins Panel
 * würde auf der Login-Maske landen. Der Klick/JS-Sprung von HIER ist same-site,
 * dann ist das Cookie wieder dabei.
 */
function callbackPage(ok, text) {
  const target = '/#/bruecke';
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Twitch-Verbindung</title>
<style>body{background:#1e1f22;color:#dbdee1;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
.box{background:#2b2d31;border:1px solid #3f4147;border-left:4px solid ${ok ? '#23a55a' : '#f23f43'};border-radius:8px;padding:24px 28px;max-width:460px}
h1{font-size:18px;margin:0 0 8px}a{color:#a5b0ff}</style></head><body><div class="box">
<h1>${ok ? '✅ Twitch verbunden' : '❌ Verbindung fehlgeschlagen'}</h1><p>${escapeHtml(text)}</p>
<p><a href="${target}" id="back">Zurück zum Panel</a></p></div>
${ok ? `<script>setTimeout(function(){location.href=${JSON.stringify(target)}},1500)</script>` : ''}
</body></html>`;
}

/**
 * ctx:
 *   password        — Admin-Passwort (Pflicht)
 *   getBrand()      — { name, emoji, color } fürs Panel-Branding (öffentlich abrufbar)
 *   getStatus()     — Status-Objekt für das Dashboard
 *   getCommands()   — aktuelle Textbefehle (Objekt, nur lesend)
 *   codeCommands    — im Code definierte Befehle [{name, description}]
 *   reservedNames   — Namen die Textbefehle nie tragen dürfen
 *   trustProxy      — optional: Express "trust proxy"-Wert, wenn hinter Reverse Proxy
 *   getSettings()   — aktuelle Live-Ansage-Einstellungen { mention }
 *   getRoles()      — Guild-Rollen fürs Dropdown [{id, name}]
 *   setMention(v)   — Mention setzen ('off'|'everyone'|Rollen-ID), wirft bei Unfug
 *   getChannels()   — Text-/Ankündigungskanäle fürs Dropdown [{id, name}]
 *   getDistributors() — Liste der Rollenverteiler [{id, name, channelId, messageId,
 *                     title, text, mappings:[{emoji, roleId}]}]
 *   createDistributor(data) — legt einen Verteiler an, gibt ihn (inkl. id) zurück
 *   updateDistributor(id, data) — ändert einen Verteiler, gibt ihn zurück; wirft 404
 *   deleteDistributor(id) — entfernt einen Verteiler; wirft 404
 *   postDistributor(id) — postet die Nachricht + Reaktionen, speichert die
 *                     messageId; gibt {distributor, failed:[emoji]} zurück (async)
 *   mutateCommands(mutator) — wendet mutator(current)->next atomar an (schreibt
 *                     Datei, lädt neu, registriert bei Discord); der Mutator darf
 *                     httpError(...) werfen. Gibt {registration} zurück.
 *   registerNow()   — Registrierung erneut anstoßen (Retry-Knopf)
 *   bridge          — optional (null = Chat-Brücke nicht konfiguriert):
 *     callbackPath  — Pfad aus TWITCH_REDIRECT_URI, z.B. /twitch/callback (öffentlich!)
 *     getState()    — alles fürs Panel-Modul (Einstellung, Konto, Laufzeit, Kanäle)
 *     setSettings({enabled, channelId}) — speichern + starten/stoppen; wirft 400
 *     connectUrl()  — Twitch-Login-URL mit Einmal-state
 *     handleCallback(query) — Code gegen Token tauschen; gibt {login}; wirft
 *     disconnect()  — Token widerrufen + löschen (async)
 *     refreshMod()  — Mod-Status neu abfragen (async, gibt true/false/null)
 *   bridgeUnavailable — { missingEnv: [...] }, wenn bridge null ist
 */
export function createAdminServer(ctx) {
  const app = express();
  const limiter = makeLimiter();
  // Aktive Sessions nur im Speicher: nach einem Neustart muss man sich neu
  // einloggen — für ein Ein-Personen-Panel völlig okay und spart einen Store.
  const sessions = new Map(); // Token -> Ablauf (ms)

  // Standardmäßig KEIN "trust proxy": bei direktem Zugriff (SSH-Tunnel oder
  // offener Port) könnte sonst jeder per gefälschtem X-Forwarded-For einen
  // eigenen Rate-Limit-Zähler bekommen und die Brute-Force-Bremse umgehen —
  // req.ip ist dann immer die echte Socket-Adresse.
  // Hinter genau EINEM Reverse Proxy kämen aber alle Anfragen von der Proxy-IP,
  // die Bremse würde alle über einen Kamm scheren. Dann ADMIN_TRUST_PROXY
  // setzen ("1" = genau ein Hop, der Normalfall; oder z.B. "loopback"): so
  // zählt wieder die echte Client-IP. Nur mit vertrauenswürdigem Proxy davor!
  if (ctx.trustProxy) {
    // Zahl-Strings ("1", "2") als Hop-Anzahl, alles andere unverändert
    // durchreichen ("loopback", ein Subnetz, ...).
    const tp = /^\d+$/.test(ctx.trustProxy) ? Number(ctx.trustProxy) : ctx.trustProxy;
    app.set('trust proxy', tp);
  }

  app.use(express.json({ limit: '200kb' }));

  // --- CSRF-Schutz: schreibende Requests brauchen einen Custom-Header. ---
  // Fremde Seiten können den ohne CORS-Freigabe nicht setzen; wir geben keine.
  // Gilt auch für Login/Logout — deren fetch() setzt den Header.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') {
      return res.status(403).json({ error: 'Header X-Requested-With: fetch fehlt' });
    }
    next();
  });

  // --- Öffentlich erreichbar: Login-Maske + Login/Logout + Branding ---
  app.get('/login', (req, res) => {
    if (hasValidSession(sessions, req)) return res.redirect('/'); // schon eingeloggt
    res.sendFile('login.html', { root: PUBLIC_DIR });
  });

  // Branding (Name/Emoji/Farbe) ist nicht sensibel und wird schon von der Login-
  // Maske gebraucht — deshalb bewusst vor dem Auth-Gate erreichbar.
  app.get('/api/brand', (_req, res) => {
    res.json(ctx.getBrand ? ctx.getBrand() : { name: '', emoji: '🤖', color: '#5865f2' });
  });

  app.post('/api/login', (req, res) => {
    // Die Brute-Force-Bremse sitzt jetzt genau hier, wo Passwörter geraten werden.
    if (limiter.locked(req.ip)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte eine Minute warten.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqual(password, ctx.password)) {
      limiter.fail(req.ip);
      return res.status(401).json({ error: 'Falsches Passwort' });
    }
    limiter.ok(req.ip);
    setSessionCookie(res, req, newSession(sessions));
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // --- Öffentlich: Rücksprung vom Twitch-Login (Chat-Brücke) ---
  // Kein Session-Check möglich (siehe callbackPage). Geschützt ist er über den
  // Einmal-"state", den nur ein eingeloggter Admin per "Verbinden" bekommt.
  // Pfad darf keine Panel-Route verdecken (/, /login, /api/…).
  const cbPath = ctx.bridge?.callbackPath;
  const cbPathOk = cbPath && cbPath !== '/' && !/^\/(api|login)(\/|$)/.test(cbPath) && !/\.html$/.test(cbPath);
  if (cbPath && !cbPathOk) console.error(`[admin] TWITCH_REDIRECT_URI-Pfad "${cbPath}" kollidiert mit dem Panel — z.B. /twitch/callback nehmen`);
  if (cbPathOk) {
    app.get(ctx.bridge.callbackPath, async (req, res) => {
      try {
        const { login } = await ctx.bridge.handleCallback(req.query ?? {});
        res.send(callbackPage(true, `Angemeldet als ${login}. Die Chat-Brücke nutzt jetzt diesen Account.`));
      } catch (err) {
        res.status(err.httpStatus || 500).send(callbackPage(false, err.message));
      }
    });
  }

  // --- Ab hier ist alles geschützt: gültige Session Pflicht. ---
  app.use((req, res, next) => {
    if (hasValidSession(sessions, req)) return next();
    // API-Aufrufe bekommen 401 (das Frontend leitet dann zur Maske weiter),
    // normale Seitenaufrufe werden direkt dorthin umgeleitet.
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht eingeloggt' });
    res.redirect('/login');
  });

  app.use(express.static(PUBLIC_DIR, { index: 'admin.html' }));

  // --- API: Status ---
  app.get('/api/status', (_req, res) => {
    res.json(ctx.getStatus());
  });

  // --- API: Befehle ---
  app.get('/api/commands', (_req, res) => {
    res.json({ commands: ctx.getCommands(), code: ctx.codeCommands, rules: RULES });
  });

  // Alle Prüfungen laufen IM Mutator, also innerhalb der Schreibsperre — so kann
  // keine gleichzeitige Änderung zwischen Prüfung und Schreiben dazwischenfunken.
  app.post('/api/commands', async (req, res) => {
    const { name, ...entry } = req.body ?? {};
    if (typeof name !== 'string') return res.status(400).json({ error: 'name fehlt' });

    try {
      const result = await ctx.mutateCommands((commands) => {
        if (commands[name]) throw httpError(409, `/${name} existiert schon`);
        if (ctx.reservedNames.includes(name)) throw httpError(400, `/${name} ist für den Bot reserviert`);
        const problem = validateEntry(name, entry);
        if (problem) throw httpError(400, problem);
        return { ...commands, [name]: normalizeEntry(entry) };
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.httpStatus || 500).json({ error: err.message });
    }
  });

  app.put('/api/commands/:name', async (req, res) => {
    const oldName = req.params.name;
    const { name: newNameRaw, ...entry } = req.body ?? {};
    const newName = typeof newNameRaw === 'string' ? newNameRaw : oldName;

    try {
      const result = await ctx.mutateCommands((commands) => {
        if (!commands[oldName]) throw httpError(404, `/${oldName} existiert nicht`);
        if (newName !== oldName && commands[newName]) throw httpError(409, `/${newName} existiert schon`);
        if (ctx.reservedNames.includes(newName)) throw httpError(400, `/${newName} ist für den Bot reserviert`);
        const problem = validateEntry(newName, entry);
        if (problem) throw httpError(400, problem);

        const next = { ...commands };
        delete next[oldName];
        next[newName] = normalizeEntry(entry);
        return next;
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.httpStatus || 500).json({ error: err.message });
    }
  });

  app.delete('/api/commands/:name', async (req, res) => {
    const name = req.params.name;

    try {
      const result = await ctx.mutateCommands((commands) => {
        if (ctx.reservedNames.includes(name))
          throw httpError(400, `/${name} ist im Code definiert und kann hier nicht gelöscht werden`);
        if (!commands[name]) throw httpError(404, `/${name} existiert nicht`);
        const next = { ...commands };
        delete next[name];
        return next;
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.httpStatus || 500).json({ error: err.message });
    }
  });

  // --- API: Registrierung manuell anstoßen (Retry nach Fehler) ---
  app.post('/api/register', async (_req, res) => {
    const registration = await ctx.registerNow();
    res.json({ ok: registration.ok, registration });
  });

  // --- API: Live-Ansage (Mention) ---
  app.get('/api/settings', (_req, res) => {
    res.json({ settings: ctx.getSettings(), roles: ctx.getRoles() });
  });

  app.put('/api/settings', (req, res) => {
    try {
      const settings = ctx.setMention(req.body?.mention);
      res.json({ ok: true, settings });
    } catch (err) {
      // Ungültige Mention -> 400 (normalizeMention wirft ohne httpStatus).
      res.status(err.httpStatus || 400).json({ error: err.message });
    }
  });

  // --- API: Rollenverteilung (Reaction-Roles) ---
  app.get('/api/roledistributors', (_req, res) => {
    res.json({ distributors: ctx.getDistributors(), channels: ctx.getChannels(), roles: ctx.getRoles() });
  });

  app.post('/api/roledistributors', (req, res) => {
    try {
      res.json({ ok: true, distributor: ctx.createDistributor(req.body ?? {}) });
    } catch (err) {
      res.status(err.httpStatus || 400).json({ error: err.message });
    }
  });

  app.put('/api/roledistributors/:id', (req, res) => {
    try {
      res.json({ ok: true, distributor: ctx.updateDistributor(req.params.id, req.body ?? {}) });
    } catch (err) {
      res.status(err.httpStatus || 400).json({ error: err.message });
    }
  });

  app.delete('/api/roledistributors/:id', (req, res) => {
    try {
      ctx.deleteDistributor(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.httpStatus || 400).json({ error: err.message });
    }
  });

  // Postet die Verteiler-Nachricht in Discord (Reaktionen inkl.) und speichert die
  // neue Message-ID. Antwort enthält failed:[] mit Emojis, die nicht gesetzt wurden.
  app.post('/api/roledistributors/:id/post', async (req, res) => {
    try {
      const result = await ctx.postDistributor(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(err.httpStatus || 500).json({ error: err.message });
    }
  });

  // --- API: Chat-Brücke Twitch <-> Discord ---
  app.get('/api/bridge', (_req, res) => {
    if (!ctx.bridge) return res.json({ available: false, missingEnv: ctx.bridgeUnavailable?.missingEnv ?? [] });
    res.json(ctx.bridge.getState());
  });

  app.put('/api/bridge', (req, res) => {
    if (!ctx.bridge) return res.status(503).json({ error: 'Chat-Brücke ist nicht konfiguriert (siehe README)' });
    try {
      const body = req.body ?? {};
      const settings = ctx.bridge.setSettings({
        ...(typeof body.enabled === 'boolean' && { enabled: body.enabled }),
        ...(typeof body.channelId === 'string' && { channelId: body.channelId }),
      });
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(err.httpStatus || 400).json({ error: err.message });
    }
  });

  app.post('/api/bridge/connect', (_req, res) => {
    if (!ctx.bridge) return res.status(503).json({ error: 'Chat-Brücke ist nicht konfiguriert' });
    res.json({ url: ctx.bridge.connectUrl() });
  });

  app.post('/api/bridge/disconnect', async (_req, res) => {
    if (!ctx.bridge) return res.status(503).json({ error: 'Chat-Brücke ist nicht konfiguriert' });
    try {
      await ctx.bridge.disconnect();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/bridge/modcheck', async (_req, res) => {
    if (!ctx.bridge) return res.status(503).json({ error: 'Chat-Brücke ist nicht konfiguriert' });
    try {
      const isMod = await ctx.bridge.refreshMod();
      res.json({ ok: true, isMod });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // JSON-Parse-Fehler sauber als 400 statt als HTML-Fehlerseite.
  app.use((err, _req, res, _next) => {
    res.status(400).json({ error: `Ungültiger Request: ${err.message}` });
  });

  return app;
}
