// Twitch-Anmeldung des Bot-Accounts (z.B. "meinbot") für die Chat-Brücke.
//
// Ablauf (Authorization Code Flow):
//   1. Im Admin-Panel "Mit Twitch verbinden" -> authorizeUrl() erzeugt einen
//      Einmal-"state" und die Twitch-Login-URL.
//   2. Man meldet sich bei Twitch MIT DEM BOT-ACCOUNT an und bestätigt.
//   3. Twitch leitet auf TWITCH_REDIRECT_URI zurück -> handleCallback() tauscht
//      den Code gegen Access- + Refresh-Token und speichert beides in data/.
//   4. Danach erneuert sich das Token selbst (refresh), stündlich wird es geprüft
//      (Twitch verlangt das: /oauth2/validate beim Start und dann stündlich).
//
// Das ist bewusst ein USER-Token des Bot-Accounts, nicht das App-Token von
// n8n//live: nur ein User-Token darf Chat lesen (EventSub über WebSocket) und
// als dieser User in den Chat schreiben.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ID_BASE = 'https://id.twitch.tv/oauth2';
export const HELIX_BASE = 'https://api.twitch.tv/helix';

// Rechte, die der Bot-Account der App gibt:
//   user:read:chat               Chat des Kanals lesen (EventSub channel.chat.*)
//   user:write:chat              als Bot-Account in den Chat schreiben
//   user:read:moderated_channels prüfen, ob der Bot Mod im Kanal ist (Panel-Anzeige)
//   moderator:manage:chat_messages  Brücken-Nachrichten auf Twitch löschen, wenn
//                                die Discord-Nachricht gelöscht wird (nur als Mod)
export const SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'user:read:moderated_channels',
  'moderator:manage:chat_messages',
];

const STATE_TTL_MS = 10 * 60 * 1000; // so lange ist ein "Verbinden"-Klick gültig
const VALIDATE_EVERY_MS = 60 * 60 * 1000;

/** Fehler mit HTTP-Status (wie in index.js/admin.js). */
function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

/**
 * opts:
 *   clientId, clientSecret — dieselbe Twitch-App wie für n8n und /live
 *   redirectUri            — exakt wie in der Twitch-Konsole eingetragen
 *   tokenFile              — Pfad der Token-Datei (liegt im data/-Mount)
 *   log(msg), logError(msg)
 */
export function createTwitchAuth({ clientId, clientSecret, redirectUri, tokenFile, log = console.log, logError = console.error }) {
  let token = null;            // { accessToken, refreshToken, expiresAt, userId, login, scopes, connectedAt }
  let lastError = null;        // Text für das Panel, z.B. "Twitch-Verbindung abgelaufen"
  let refreshing = null;       // laufender Refresh (single-flight)
  const pendingStates = new Map(); // state -> Ablauf (ms)
  const listeners = new Set();

  const notify = () => { for (const fn of listeners) { try { fn(); } catch (err) { logError(`[twitch-auth] Listener: ${err.message}`); } } };

  // --- Datei ---
  function load() {
    if (!existsSync(tokenFile)) return;
    try {
      const raw = JSON.parse(readFileSync(tokenFile, 'utf8'));
      if (raw?.accessToken && raw?.refreshToken && raw?.userId) token = raw;
    } catch (err) {
      lastError = `Token-Datei unlesbar: ${err.message}`;
      logError(`[twitch-auth] ${lastError}`);
    }
  }

  function save() {
    const json = JSON.stringify(token, null, 2);
    const tmp = `${tokenFile}.tmp`;
    try {
      writeFileSync(tmp, json, { mode: 0o600 });
      renameSync(tmp, tokenFile);
    } catch {
      writeFileSync(tokenFile, json, { mode: 0o600 });
    }
    try { chmodSync(tokenFile, 0o600); } catch { /* egal */ }
  }

  function clear(reason) {
    token = null;
    lastError = reason ?? null;
    try { if (existsSync(tokenFile)) unlinkSync(tokenFile); } catch (err) { logError(`[twitch-auth] Token-Datei nicht löschbar: ${err.message}`); }
    notify();
  }

  // --- Twitch-Aufrufe ---
  async function postForm(path, params) {
    const res = await fetch(`${ID_BASE}/${path}`, { method: 'POST', body: new URLSearchParams(params) });
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { res, json };
  }

  /** /oauth2/validate: wem gehört das Token, welche Rechte hat es? null = ungültig. */
  async function validateToken(accessToken) {
    const res = await fetch(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`Twitch-Validate fehlgeschlagen (HTTP ${res.status})`);
    return res.json();
  }

  function fromTokenResponse(json, info) {
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      userId: info.user_id,
      login: info.login,
      scopes: Array.isArray(info.scopes) ? info.scopes : (json.scope ?? []),
      connectedAt: token?.connectedAt ?? new Date().toISOString(),
    };
  }

  // --- Öffentliche Funktionen ---

  /** Login-URL für den "Verbinden"-Knopf. Der state ist 10 Minuten gültig, einmalig. */
  function authorizeUrl() {
    const now = Date.now();
    for (const [s, exp] of pendingStates) if (exp <= now) pendingStates.delete(s);
    const state = randomBytes(24).toString('hex');
    pendingStates.set(state, now + STATE_TTL_MS);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      // Immer den Bestätigungsdialog zeigen — dort sieht man auch, als WER man
      // gerade bei Twitch angemeldet ist (soll der Bot-Account sein, nicht der eigene).
      force_verify: 'true',
    });
    return `${ID_BASE}/authorize?${params}`;
  }

  /**
   * Rücksprung von Twitch. query = { code, state, error, error_description }.
   * Gibt { login } zurück oder wirft (httpStatus 400 bei ungültigem state etc.).
   */
  async function handleCallback(query) {
    const state = typeof query?.state === 'string' ? query.state : '';
    const exp = pendingStates.get(state);
    pendingStates.delete(state);
    // state prüfen: schützt davor, dass jemand anderes uns sein Token unterschiebt
    // (CSRF). Nur wer im Panel eingeloggt "Verbinden" geklickt hat, kennt ihn.
    if (!exp || exp < Date.now()) throw httpError(400, 'Anmeldung abgelaufen oder ungültig. Bitte im Panel erneut auf „Mit Twitch verbinden" klicken.');
    if (query.error) throw httpError(400, `Twitch hat die Anmeldung abgebrochen: ${query.error_description || query.error}`);
    if (typeof query.code !== 'string' || !query.code) throw httpError(400, 'Twitch hat keinen Code mitgeschickt.');

    const { res, json } = await postForm('token', {
      client_id: clientId,
      client_secret: clientSecret,
      code: query.code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    if (!res.ok || !json?.access_token) {
      throw httpError(502, `Token-Tausch fehlgeschlagen (HTTP ${res.status}): ${json?.message ?? 'unbekannt'}`);
    }
    const info = await validateToken(json.access_token);
    if (!info) throw httpError(502, 'Twitch hat das neue Token sofort abgelehnt.');

    // Altes Token (falls anderer Account) widerrufen, damit nichts herumliegt.
    if (token && token.userId !== info.user_id) await revoke(token.accessToken);
    token = { ...fromTokenResponse(json, info), connectedAt: new Date().toISOString() };
    lastError = null;
    save();
    log(`[twitch-auth] verbunden als ${token.login} (${token.userId}), Rechte: ${token.scopes.join(' ')}`);
    notify();
    return { login: token.login };
  }

  /** Token erneuern. Mehrere gleichzeitige Aufrufer teilen sich einen Refresh. */
  function refresh() {
    if (!token) return Promise.reject(new Error('Twitch nicht verbunden'));
    if (refreshing) return refreshing;
    const startedWith = token; // ändert sich das während des Refreshs (Trennen/neu verbinden), verwerfen
    refreshing = (async () => {
      try {
        const { res, json } = await postForm('token', {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        });
        if (token !== startedWith) throw new Error('Token wurde währenddessen geändert');
        const invalidRefresh = res.status === 401 || (res.status === 400 && /refresh/i.test(json?.message ?? ''));
        if (invalidRefresh) {
          // Refresh-Token ungültig (Passwort geändert, App getrennt, …): nur
          // Neu-Verbinden hilft. Datei löschen, sonst würde es endlos neu versucht.
          clear('Twitch-Verbindung abgelaufen — bitte im Panel neu verbinden.');
          logError(`[twitch-auth] Refresh abgelehnt (HTTP ${res.status}): ${json?.message ?? ''}`);
          throw new Error('Twitch-Verbindung abgelaufen');
        }
        if (!res.ok || !json?.access_token) {
          // z.B. 403 "invalid client secret": Konfigurationsfehler, Token NICHT wegwerfen.
          lastError = `Token-Erneuerung fehlgeschlagen (HTTP ${res.status}): ${json?.message ?? 'unbekannt'} — Client-ID/Secret prüfen`;
          throw new Error(lastError);
        }
        const info = await validateToken(json.access_token);
        if (!info) throw new Error('Erneuertes Token ungültig');
        if (token !== startedWith) throw new Error('Token wurde währenddessen geändert');
        token = fromTokenResponse(json, info);
        lastError = null;
        save();
        return token.accessToken;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Gültiges Access-Token (erneuert 2 Minuten vor Ablauf selbst). */
  async function getAccessToken() {
    if (!token) throw new Error('Twitch nicht verbunden');
    if (Date.now() > token.expiresAt - 120_000) return refresh();
    return token.accessToken;
  }

  /** Stündliche Pflichtprüfung. Ungültig -> Refresh versuchen. */
  async function validateNow() {
    if (!token) return;
    try {
      const info = await validateToken(token.accessToken);
      if (!info) {
        log('[twitch-auth] Token ungültig, erneuere …');
        await refresh();
      } else if (Array.isArray(info.scopes)) {
        token.scopes = info.scopes;
      }
    } catch (err) {
      logError(`[twitch-auth] Prüfung fehlgeschlagen: ${err.message}`);
    }
  }

  async function revoke(accessToken) {
    try {
      await postForm('revoke', { client_id: clientId, token: accessToken });
    } catch (err) {
      logError(`[twitch-auth] Widerruf fehlgeschlagen: ${err.message}`);
    }
  }

  /** "Trennen" im Panel: Token bei Twitch widerrufen und lokal löschen. */
  async function disconnect() {
    if (token) await revoke(token.accessToken);
    clear(null);
    log('[twitch-auth] getrennt');
  }

  /**
   * Helix-Aufruf mit dem Bot-Token. Bei 401 einmal erneuern und wiederholen.
   * Gibt { status, json } zurück (json kann null sein, z.B. bei 204).
   */
  async function helix(method, path, { query, body } = {}) {
    const url = `${HELIX_BASE}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
    const call = async (accessToken) => fetch(url, {
      method,
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${accessToken}`,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    let res = await call(await getAccessToken());
    if (res.status === 401 && token) res = await call(await refresh());
    let json = null;
    try { json = await res.json(); } catch { /* 204 / leer */ }
    return { status: res.status, json };
  }

  /** Für Panel/Status. Nie das Token selbst herausgeben. */
  function info() {
    const scopes = token?.scopes ?? [];
    return {
      connected: Boolean(token),
      login: token?.login ?? null,
      userId: token?.userId ?? null,
      connectedAt: token?.connectedAt ?? null,
      missingScopes: token ? SCOPES.filter((s) => !scopes.includes(s)) : [],
      error: lastError,
    };
  }

  load();
  const timer = setInterval(validateNow, VALIDATE_EVERY_MS);
  timer.unref?.();
  if (token) validateNow(); // beim Start einmal prüfen

  return {
    authorizeUrl,
    handleCallback,
    getAccessToken,
    refresh,
    disconnect,
    helix,
    info,
    isConnected: () => Boolean(token),
    getUser: () => (token ? { id: token.userId, login: token.login } : null),
    onChange: (fn) => listeners.add(fn),
  };
}
