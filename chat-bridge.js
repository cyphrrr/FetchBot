// Chat-Brücke: Twitch-Chat <-> ein Discord-Kanal (im Admin-Panel wählbar).
//
//   Twitch -> Discord: EventSub über WebSocket (channel.chat.message). Gepostet
//                      wird per Webhook, damit jede Nachricht mit Twitch-Name und
//                      Twitch-Avatar erscheint: "kaffeejunkie (Twitch)".
//   Discord -> Twitch: messageCreate im Brücken-Kanal -> Helix "Send Chat Message"
//                      als Bot-Account: "Lena (Discord): Text".
//
// Moderation:
//   - Twitch-Mod löscht eine Nachricht      -> die Discord-Kopie verschwindet auch.
//   - Twitch-Ban/Timeout                    -> Discord-Kopien dieser Person verschwinden.
//   - Discord-Nachricht wird gelöscht       -> die Twitch-Kopie verschwindet (nur wenn
//                                              der Bot Mod im Kanal ist).
//   - Twitch verwirft eine Nachricht (AutoMod, Slow-Mode …) -> 🚫 an der Discord-Nachricht.
//   - Warteschlange voll / Fehler           -> ⚠️ an der Discord-Nachricht.
//
// Schleifenschutz: Nachrichten des Bot-Accounts auf Twitch und Webhook-/Bot-
// Nachrichten in Discord werden nie zurückgespiegelt.
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  twitchToDiscord, webhookUsername, discordToTwitchText, twitchPrefix, splitForTwitch,
  nameKey, BoundedMap,
} from './bridge-format.js';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const DEFAULT_WEBHOOK_NAME = 'FetchBot Chat-Brücke';
const SUB_TYPES = ['channel.chat.message', 'channel.chat.message_delete', 'channel.chat.clear_user_messages'];

// Twitch-Limits fürs Schreiben: Mods 100 / 30s, sonst 20 / 30s. Mit Puffer.
const WINDOW_MS = 30_000;
const LIMIT_MOD = 90;
const LIMIT_USER = 18;
const TWITCH_QUEUE_MAX = 40;    // Nachrichtenteile
const DISCORD_QUEUE_MAX = 50;   // Nachrichten
const MOD_CHECK_EVERY_MS = 10 * 60 * 1000;
const MENTION_RECENT_MS = 2 * 60 * 60 * 1000; // @Name zählt nur für kürzlich Aktive
const MAX_429_RETRIES = 3;
const AVATAR_TTL_MS = 12 * 60 * 60 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

const EMOJI_DROPPED = '🚫'; // Twitch hat die Nachricht nicht angenommen
const EMOJI_FAILED = '⚠️';  // Brücke konnte nicht senden

/** Rechte, die der Bot im Brücken-Kanal braucht — mit deutschen Namen fürs Panel. */
export const BRIDGE_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'Kanal ansehen'],
  [PermissionFlagsBits.SendMessages, 'Nachrichten senden'],
  [PermissionFlagsBits.ManageWebhooks, 'Webhooks verwalten'],
  [PermissionFlagsBits.AddReactions, 'Reaktionen hinzufügen'],
  [PermissionFlagsBits.ReadMessageHistory, 'Nachrichtenverlauf lesen'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * opts:
 *   client           — discord.js Client
 *   auth             — aus createTwitchAuth()
 *   broadcasterLogin — Twitch-Kanal (TWITCH_LOGIN), klein geschrieben
 *   getSettings()    — liefert { enabled, channelId } der Brücke (frisch bei jedem Aufruf)
 *   webhookName      — Name des Webhooks im Kanal (Branding), z.B. "Napoli Chat-Brücke"
 *   log, logError
 */
export function createChatBridge({ client, auth, broadcasterLogin, getSettings, webhookName = DEFAULT_WEBHOOK_NAME, log = console.log, logError = console.error }) {
  let running = false;
  let generation = 0;         // zählt jeden Start hoch; alte async-Reste erkennen sich daran
  let activeChannelId = null;
  let activeBotId = null;
  let activeConnectedAt = null;
  let connection = 'aus';     // aus | verbinde | verbunden | getrennt | fehler
  let lastError = null;
  let broadcaster = null;     // { id, login, name }
  let isMod = null;           // true | false | null (unbekannt)
  let modCheckedAt = null;
  const stats = { toDiscord: 0, toTwitch: 0, dropped: 0, since: new Date().toISOString() };

  // --- WebSocket-Zustand ---
  let current = null;         // aktive EventSub-Verbindung
  let watchdog = null;
  let keepaliveSec = 10;
  let reconnectTimer = null;
  let backoff = 1000;
  let modTimer = null;

  // --- Zuordnungen fürs Löschen / Antworten / Erwähnen (nur im Speicher) ---
  const seenEvents = new BoundedMap(500);          // EventSub message_id (Duplikate)
  const mirrorByTwitchId = new BoundedMap(1000);   // Twitch-Msg -> Discord-Webhook-Msg
  const twitchByMirrorId = new BoundedMap(1000);   // Discord-Webhook-Msg -> Twitch-Msg
  const mirrorsByChatter = new BoundedMap(500);    // Twitch-User -> [Discord-Webhook-Msgs]
  const relayByDiscordId = new BoundedMap(1000);   // Discord-Original -> [Twitch-Msgs]
  const relayAuthorByTwitchId = new BoundedMap(1000); // Brücken-Msg auf Twitch -> Discord-User-ID
  const discordNames = new BoundedMap(1000);       // nameKey -> { id, at }
  const avatars = new BoundedMap(2000);            // Twitch-User -> { url, at }
  const reacted = new BoundedMap(500);             // Discord-Msg -> schon markiert
  let webhookCache = { channelId: null, webhook: null };

  const settings = () => getSettings() ?? { enabled: false, channelId: '' };
  const bot = () => auth.getUser();

  function resetMaps() {
    for (const m of [mirrorByTwitchId, twitchByMirrorId, mirrorsByChatter, relayByDiscordId, relayAuthorByTwitchId, reacted]) m.clear();
    webhookCache = { channelId: null, webhook: null };
  }

  function setError(msg) {
    lastError = msg;
    if (msg) logError(`[brücke] ${msg}`);
  }

  // ============================================================
  // Twitch-Grunddaten: Kanal-ID und Mod-Status
  // ============================================================

  async function ensureBroadcaster() {
    if (broadcaster) return broadcaster;
    const { status, json } = await auth.helix('GET', '/users', { query: { login: broadcasterLogin } });
    if (status !== 200) throw new Error(`Twitch-Kanal konnte nicht abgefragt werden (HTTP ${status})`);
    const u = json?.data?.[0];
    if (!u) throw new Error(`Twitch-Kanal „${broadcasterLogin}" nicht gefunden — TWITCH_LOGIN prüfen`);
    broadcaster = { id: u.id, login: u.login, name: u.display_name };
    return broadcaster;
  }

  /** Ist der Bot-Account Mod im Kanal? Für Panel-Anzeige und Sende-Limit. */
  async function refreshModStatus() {
    const me = bot();
    if (!me) { isMod = null; modCheckedAt = null; return null; }
    try {
      const b = await ensureBroadcaster();
      if (me.id === b.id) { isMod = true; modCheckedAt = new Date().toISOString(); return true; }
      let after;
      let found = false;
      // Seitenweise (max. 5 Seiten à 100) — ein Bot moderiert selten mehr Kanäle.
      for (let page = 0; page < 5 && !found; page++) {
        const { status, json } = await auth.helix('GET', '/moderation/channels', {
          query: { user_id: me.id, first: '100', ...(after && { after }) },
        });
        if (status === 401 || status === 403) throw new Error('Token fehlt das Recht user:read:moderated_channels — im Panel neu verbinden');
        if (status !== 200) throw new Error(`Mod-Abfrage fehlgeschlagen (HTTP ${status})`);
        found = (json?.data ?? []).some((c) => c.broadcaster_id === b.id);
        after = json?.pagination?.cursor;
        if (!after) break;
      }
      isMod = found;
      modCheckedAt = new Date().toISOString();
      return isMod;
    } catch (err) {
      logError(`[brücke] Mod-Status: ${err.message}`);
      isMod = null;
      return null;
    }
  }

  // ============================================================
  // EventSub-WebSocket
  // ============================================================

  function retire(sock) {
    if (!sock) return;
    sock.retired = true;
    try { sock.close(); } catch { /* egal */ }
  }

  function clearWatchdog() { if (watchdog) clearTimeout(watchdog); watchdog = null; }

  /** Kommt länger nichts (nicht mal ein Keepalive), ist die Verbindung tot. */
  function armWatchdog() {
    clearWatchdog();
    watchdog = setTimeout(() => {
      log('[brücke] keine Keepalives mehr von Twitch — verbinde neu');
      const sock = current;
      current = null;
      retire(sock);
      scheduleReconnect();
    }, (keepaliveSec + 10) * 1000);
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    connection = connection === 'fehler' ? 'fehler' : 'getrennt';
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (running) connect(EVENTSUB_URL); }, delay);
  }

  function connect(url, { asReconnect = false } = {}) {
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      setError(`WebSocket konnte nicht geöffnet werden: ${err.message}`);
      scheduleReconnect();
      return null;
    }
    if (!asReconnect) {
      current = sock;
      connection = 'verbinde';
      keepaliveSec = 10;
      armWatchdog(); // kommt nicht mal ein Welcome, gilt die Verbindung als tot
    }
    sock.addEventListener('message', (e) => {
      onSocketMessage(sock, typeof e.data === 'string' ? e.data : String(e.data)).catch((err) => {
        logError(`[brücke] Verarbeitung fehlgeschlagen: ${err.message}`);
      });
    });
    sock.addEventListener('close', (e) => {
      if (sock.retired || sock !== current) return;
      current = null;
      clearWatchdog();
      if (!running) return;
      // 4003 = nicht rechtzeitig abonniert, 4004 = Reconnect-Grace verpasst, 4007 = ungültiger Reconnect
      log(`[brücke] EventSub-Verbindung geschlossen (Code ${e.code}${e.reason ? ', ' + e.reason : ''})`);
      scheduleReconnect();
    });
    sock.addEventListener('error', () => { /* close folgt */ });
    return sock;
  }

  async function subscribeAll(sessionId) {
    const me = bot();
    const b = await ensureBroadcaster();
    for (const type of SUB_TYPES) {
      const { status, json } = await auth.helix('POST', '/eventsub/subscriptions', {
        body: {
          type,
          version: '1',
          condition: { broadcaster_user_id: b.id, user_id: me.id },
          transport: { method: 'websocket', session_id: sessionId },
        },
      });
      if (status === 202 || status === 409) continue; // 409 = existiert schon
      const why = json?.message ?? `HTTP ${status}`;
      if (type === 'channel.chat.message') {
        // Ohne Chat-Abo ist die Brücke nutzlos -> laut scheitern.
        throw new Error(`Chat-Abo bei Twitch abgelehnt: ${why}${status === 403 ? ' (Rechte fehlen — im Panel neu verbinden)' : ''}`);
      }
      logError(`[brücke] Abo ${type} abgelehnt: ${why} — Löschungen werden ggf. nicht gespiegelt`);
    }
  }

  async function onSocketMessage(sock, raw) {
    if (sock.retired) return;
    if (!running) { retire(sock); return; } // Rest nach stop(), z.B. ein Reconnect-Socket
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg?.metadata?.message_type;
    if (sock === current) armWatchdog();

    switch (type) {
      case 'session_welcome': {
        const session = msg.payload?.session ?? {};
        keepaliveSec = Number(session.keepalive_timeout_seconds) || 10;
        if (sock !== current) {
          // Neue Verbindung nach session_reconnect: Abos ziehen automatisch mit um.
          const old = current;
          current = sock;
          retire(old);
          armWatchdog();
          log('[brücke] EventSub-Verbindung gewechselt (Twitch-Reconnect)');
        } else {
          const gen = generation;
          try {
            await subscribeAll(session.id);
            if (gen !== generation || !running) { retire(sock); return; } // inzwischen gestoppt
          } catch (err) {
            if (gen !== generation || !running) { retire(sock); return; }
            connection = 'fehler';
            setError(err.message);
            current = null;
            clearWatchdog();
            retire(sock);
            scheduleReconnect();
            return;
          }
          log(`[brücke] verbunden mit Twitch-Chat von ${broadcaster?.login}`);
          if (isMod == null) refreshModStatus();
        }
        connection = 'verbunden';
        lastError = null;
        backoff = 1000;
        return;
      }
      case 'session_keepalive':
        return;
      case 'session_reconnect': {
        const url = msg.payload?.session?.reconnect_url;
        if (url) connect(url, { asReconnect: true });
        return;
      }
      case 'revocation': {
        const sub = msg.payload?.subscription;
        setError(`Twitch hat das Abo ${sub?.type} beendet (${sub?.status})`);
        if (sub?.type === 'channel.chat.message') {
          connection = 'fehler';
          const old = current;
          current = null;
          clearWatchdog();
          retire(old);
          scheduleReconnect();
        }
        return;
      }
      case 'notification': {
        const id = msg.metadata?.message_id;
        if (id) {
          if (seenEvents.has(id)) return; // Twitch kann doppelt zustellen
          seenEvents.set(id, true);
        }
        const event = msg.payload?.event;
        const subType = msg.metadata?.subscription_type;
        if (subType === 'channel.chat.message') onTwitchMessage(event);
        else if (subType === 'channel.chat.message_delete') onTwitchDelete(event?.message_id);
        else if (subType === 'channel.chat.clear_user_messages') onTwitchClearUser(event?.target_user_id);
        return;
      }
      default:
    }
  }

  // ============================================================
  // Twitch -> Discord
  // ============================================================

  let discordChain = Promise.resolve();
  let discordPending = 0;

  function enqueueDiscord(label, fn) {
    if (discordPending >= DISCORD_QUEUE_MAX) {
      stats.dropped++;
      logError(`[brücke] Discord-Warteschlange voll — ${label} verworfen`);
      return;
    }
    discordPending++;
    discordChain = discordChain
      .then(fn)
      .catch((err) => logError(`[brücke] ${label}: ${err.message}`))
      .finally(() => { discordPending--; });
  }

  async function getWebhook() {
    const channelId = settings().channelId;
    if (webhookCache.channelId === channelId && webhookCache.webhook) return webhookCache.webhook;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.fetchWebhooks !== 'function') {
      throw new Error(`Kanal ${channelId} nicht gefunden oder kein Textkanal`);
    }
    const hooks = await channel.fetchWebhooks().catch((err) => {
      throw new Error(`Webhooks nicht lesbar (fehlt „Webhooks verwalten"?): ${err.message}`);
    });
    // Eigener Webhook des Bots: bevorzugt mit passendem Namen, sonst irgendeiner
    // von uns (z.B. nach Umbenennen von BRAND_NAME) — so entstehen keine Dubletten.
    const own = hooks.filter((h) => h.owner?.id === client.user.id && h.token);
    let hook = own.find((h) => h.name === webhookName) ?? own[0];
    if (!hook) {
      hook = await channel.createWebhook({ name: webhookName, reason: 'Chat-Brücke Twitch <-> Discord' });
      log(`[brücke] Webhook in #${channel.name} angelegt`);
    }
    webhookCache = { channelId, webhook: hook };
    return hook;
  }

  async function getAvatar(userId) {
    const hit = avatars.get(userId);
    if (hit && Date.now() - hit.at < AVATAR_TTL_MS) return hit.url;
    try {
      const { status, json } = await auth.helix('GET', '/users', { query: { id: userId } });
      const url = status === 200 ? json?.data?.[0]?.profile_image_url ?? null : null;
      avatars.set(userId, { url, at: Date.now() });
      return url;
    } catch {
      return hit?.url ?? null;
    }
  }

  const resolveMention = (name) => {
    const hit = discordNames.get(nameKey(name));
    return hit && Date.now() - hit.at < MENTION_RECENT_MS ? hit.id : null;
  };

  /**
   * Eigene Brücken-Nachricht auf Twitch? Normalfall (Bot-Account != Streamer):
   * alles vom Bot-Account. Ist der Bot-Account der Streamer selbst, nur das, was
   * die Brücke gesendet hat — sonst kämen die Nachrichten des Streamers nie an.
   */
  function isOwnRelay(ev, me) {
    if (!me || ev.chatter_user_id !== me.id) return false;
    if (!broadcaster || me.id !== broadcaster.id) return true;
    return relayAuthorByTwitchId.has(ev.message_id) || /^\S.{0,40} \(Discord\): /u.test(ev.message?.text ?? '');
  }

  function onTwitchMessage(ev) {
    if (!running || !ev) return;
    const me = bot();
    if (isOwnRelay(ev, me)) return;                              // eigene Brücken-Nachricht
    if (ev.source_broadcaster_user_id && broadcaster && ev.source_broadcaster_user_id !== broadcaster.id) {
      return; // Shared Chat: Nachrichten aus dem Partnerkanal nicht spiegeln
    }
    // Antwort auf eine Brücken-Nachricht ("Lena (Discord): …") -> Lena erwähnen.
    const replyMentionId = ev.reply?.parent_user_id === me?.id
      ? relayAuthorByTwitchId.get(ev.reply.parent_message_id) ?? null
      : null;
    const { content, mentionIds } = twitchToDiscord(ev, resolveMention, { replyMentionId });
    if (!content) return;

    const gen = generation;
    const channelAtEnqueue = activeChannelId;
    enqueueDiscord('Twitch-Nachricht', async () => {
      // Nach Stopp oder Kanalwechsel nicht mehr (in den neuen Kanal) posten.
      if (gen !== generation || !running || channelAtEnqueue !== activeChannelId) return;
      const send = async () => {
        const hook = await getWebhook();
        return hook.send({
          content,
          username: webhookUsername(ev.chatter_user_name || ev.chatter_user_login),
          avatarURL: (await getAvatar(ev.chatter_user_id)) ?? undefined,
          allowedMentions: { parse: [], users: mentionIds },
          flags: MessageFlags.SuppressEmbeds, // keine Link-Vorschauen, wie auf Twitch
        });
      };
      let sent;
      try {
        sent = await send();
      } catch (err) {
        if (err?.code !== 10015) throw err; // 10015 = Unknown Webhook (gelöscht) -> neu anlegen
        webhookCache = { channelId: null, webhook: null };
        sent = await send();
      }
      stats.toDiscord++;
      mirrorByTwitchId.set(ev.message_id, sent.id);
      twitchByMirrorId.set(sent.id, ev.message_id);
      const list = mirrorsByChatter.get(ev.chatter_user_id) ?? [];
      list.push(sent.id);
      mirrorsByChatter.set(ev.chatter_user_id, list.slice(-50));
    });
  }

  function deleteMirror(discordMessageId, why) {
    const gen = generation;
    enqueueDiscord(`Löschen (${why})`, async () => {
      if (gen !== generation) return;
      const hook = await getWebhook();
      await hook.deleteMessage(discordMessageId).catch((err) => {
        if (err?.code !== 10008) throw err; // 10008 = schon weg
      });
    });
  }

  function onTwitchDelete(twitchMessageId) {
    if (!running || !twitchMessageId) return;
    const discordId = mirrorByTwitchId.get(twitchMessageId);
    if (!discordId) return;
    mirrorByTwitchId.delete(twitchMessageId);
    twitchByMirrorId.delete(discordId);
    deleteMirror(discordId, 'Twitch-Mod hat gelöscht');
  }

  function onTwitchClearUser(twitchUserId) {
    if (!running || !twitchUserId) return;
    if (twitchUserId === bot()?.id) return;
    const ids = mirrorsByChatter.get(twitchUserId) ?? [];
    mirrorsByChatter.delete(twitchUserId);
    for (const id of ids) {
      const tid = twitchByMirrorId.get(id);
      if (tid) mirrorByTwitchId.delete(tid);
      twitchByMirrorId.delete(id);
      deleteMirror(id, 'Ban/Timeout auf Twitch');
    }
    if (ids.length) log(`[brücke] ${ids.length} Discord-Kopie(n) nach Ban/Timeout entfernt`);
  }

  // ============================================================
  // Discord -> Twitch
  // ============================================================

  const twitchQueue = [];   // { discordMessage, part, replyTo }
  const sentTimes = [];
  let pumping = false;

  async function markDiscord(message, emoji) {
    if (reacted.has(message.id)) return;
    reacted.set(message.id, true);
    await message.react(emoji).catch(() => { /* Recht fehlt -> nur Log */ });
  }

  async function waitForSlot() {
    for (;;) {
      const limit = isMod === true ? LIMIT_MOD : LIMIT_USER;
      const now = Date.now();
      while (sentTimes.length && now - sentTimes[0] > WINDOW_MS) sentTimes.shift();
      if (sentTimes.length < limit) return;
      await sleep(sentTimes[0] + WINDOW_MS - now + 50);
    }
  }

  async function sendPart(item) {
    const me = bot();
    if (!me || !broadcaster) return;
    let res;
    try {
      res = await auth.helix('POST', '/chat/messages', {
        body: {
          broadcaster_id: broadcaster.id,
          sender_id: me.id,
          message: item.part,
          ...(item.replyTo && { reply_parent_message_id: item.replyTo }),
        },
      });
    } catch (err) {
      stats.dropped++;
      logError(`[brücke] Senden an Twitch fehlgeschlagen: ${err.message}`);
      await markDiscord(item.discordMessage, EMOJI_FAILED);
      return;
    }
    sentTimes.push(Date.now());
    const { status, json } = res;

    if (status === 200) {
      const d = json?.data?.[0];
      if (d?.is_sent) {
        stats.toTwitch++;
        const list = relayByDiscordId.get(item.discordMessage.id) ?? [];
        list.push(d.message_id);
        relayByDiscordId.set(item.discordMessage.id, list);
        relayAuthorByTwitchId.set(d.message_id, item.discordMessage.author.id);
      } else {
        stats.dropped++;
        log(`[brücke] Twitch hat eine Nachricht verworfen: ${d?.drop_reason?.code ?? '?'} — ${d?.drop_reason?.message ?? ''}`);
        await markDiscord(item.discordMessage, EMOJI_DROPPED);
      }
      return;
    }
    if (status === 429) {
      const retries = (item.retries ?? 0) + 1;
      if (retries <= MAX_429_RETRIES) {
        twitchQueue.unshift({ ...item, retries }); // kurz warten, nochmal versuchen
        await sleep(5000);
        return;
      }
      stats.dropped++;
      logError('[brücke] Twitch-Rate-Limit — Nachricht nach mehreren Versuchen verworfen');
      await markDiscord(item.discordMessage, EMOJI_FAILED);
      return;
    }
    if (status === 400 && item.replyTo) {
      // Häufig: Nachricht, auf die geantwortet wurde, gibt es nicht mehr -> ohne Antwortbezug senden.
      twitchQueue.unshift({ ...item, replyTo: null });
      return;
    }
    stats.dropped++;
    logError(`[brücke] Twitch lehnt Nachricht ab (HTTP ${status}): ${json?.message ?? ''}`);
    await markDiscord(item.discordMessage, EMOJI_FAILED);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (twitchQueue.length && running) {
        await waitForSlot();
        const item = twitchQueue.shift();
        if (item) await sendPart(item);
      }
    } finally {
      pumping = false;
    }
  }

  /** messageCreate aus index.js. */
  function handleDiscordMessage(message) {
    if (!running || !broadcaster) return;
    if (message.channelId !== settings().channelId) return;
    if (!message.guild || message.author?.bot || message.webhookId || message.system) return;

    const text = discordToTwitchText(message.cleanContent);
    if (!text) return; // nur Anhang/Sticker/GIF -> nur Text wird übertragen

    const name = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    // Damit "@Lena" auf Twitch in Discord zur echten Erwähnung wird (nur für
    // kürzlich Aktive, siehe resolveMention).
    const seen = { id: message.author.id, at: Date.now() };
    discordNames.set(nameKey(name), seen);
    discordNames.set(nameKey(message.author.username), seen);

    // Antwort auf eine Brücken-Nachricht -> auf Twitch als echte Antwort senden.
    const refId = message.reference?.messageId;
    const replyTo = refId ? (twitchByMirrorId.get(refId) ?? relayByDiscordId.get(refId)?.[0] ?? null) : null;

    const parts = splitForTwitch(twitchPrefix(name), text);
    if (twitchQueue.length + parts.length > TWITCH_QUEUE_MAX) {
      stats.dropped++;
      logError('[brücke] Twitch-Warteschlange voll — Discord-Nachricht verworfen');
      markDiscord(message, EMOJI_FAILED);
      return;
    }
    parts.forEach((part, i) => twitchQueue.push({ discordMessage: message, part, replyTo: i === 0 ? replyTo : null }));
    pump().catch((err) => logError(`[brücke] Warteschlange: ${err.message}`));
  }

  /** messageDelete aus index.js: Twitch-Kopie mitlöschen (geht nur als Mod). */
  function handleDiscordDelete(message) {
    if (!running || !message?.id) return;
    // Discord-Mod löscht eine gespiegelte Twitch-Nachricht: nur in Discord weg.
    // Auf Twitch moderieren die Twitch-Mods. Zuordnung aufräumen, fertig.
    const mirroredFrom = twitchByMirrorId.get(message.id);
    if (mirroredFrom) {
      twitchByMirrorId.delete(message.id);
      mirrorByTwitchId.delete(mirroredFrom);
      return;
    }
    // Noch nicht gesendet? Dann gar nicht erst senden.
    for (let i = twitchQueue.length - 1; i >= 0; i--) {
      if (twitchQueue[i].discordMessage.id === message.id) twitchQueue.splice(i, 1);
    }
    const ids = relayByDiscordId.get(message.id);
    if (!ids?.length) return;
    relayByDiscordId.delete(message.id);
    if (isMod !== true) {
      log('[brücke] Discord-Nachricht gelöscht, Twitch-Kopie bleibt (Bot ist kein Mod)');
      return;
    }
    const me = bot();
    for (const id of ids) {
      auth.helix('DELETE', '/moderation/chat', {
        query: { broadcaster_id: broadcaster.id, moderator_id: me.id, message_id: id },
      }).then(({ status, json }) => {
        if (status !== 204 && status !== 404) logError(`[brücke] Twitch-Kopie nicht löschbar (HTTP ${status}): ${json?.message ?? ''}`);
      }).catch((err) => logError(`[brücke] Twitch-Kopie nicht löschbar: ${err.message}`));
    }
  }

  // ============================================================
  // Start / Stopp
  // ============================================================

  function shouldRun() {
    const s = settings();
    return Boolean(auth.isConnected() && s.enabled && s.channelId && client.isReady());
  }

  async function start() {
    running = true;
    const gen = ++generation;
    activeChannelId = settings().channelId;
    activeBotId = bot()?.id ?? null;
    activeConnectedAt = auth.info().connectedAt;
    connection = 'verbinde';
    backoff = 1000;
    if (modTimer) clearInterval(modTimer);
    modTimer = setInterval(refreshModStatus, MOD_CHECK_EVERY_MS);
    modTimer.unref?.();
    try {
      await ensureBroadcaster();
    } catch (err) {
      if (gen !== generation) return;
      connection = 'fehler';
      setError(err.message);
      // Später nochmal: das Welcome der neuen Verbindung ruft ensureBroadcaster erneut.
      scheduleReconnect();
      return;
    }
    if (gen !== generation || !running) return; // inzwischen gestoppt/neu gestartet
    refreshModStatus();
    connect(EVENTSUB_URL);
  }

  function stop() {
    running = false;
    generation++;
    connection = 'aus';
    clearWatchdog();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (modTimer) clearInterval(modTimer);
    modTimer = null;
    const sock = current;
    current = null;
    retire(sock);
    twitchQueue.length = 0;
    log('[brücke] gestoppt');
  }

  /** Nach jeder Änderung (Panel, Login, Discord bereit) aufrufen: startet/stoppt passend. */
  function reconcile() {
    const want = shouldRun();
    const botId = bot()?.id ?? null;
    // Neu verbunden (anderer Account ODER gleicher mit neuen Rechten) -> neu starten,
    // damit vorher abgelehnte Abos mit dem neuen Token nochmal versucht werden.
    const reconnected = auth.info().connectedAt !== activeConnectedAt;
    if (running && (!want || botId !== activeBotId || reconnected)) {
      stop();
      resetMaps();
    }
    if (running && settings().channelId !== activeChannelId) {
      // Nur der Discord-Kanal hat sich geändert: Verbindung zu Twitch bleibt.
      activeChannelId = settings().channelId;
      resetMaps();
      log(`[brücke] Discord-Kanal gewechselt auf ${activeChannelId}`);
    }
    if (!running && want) {
      start().catch((err) => setError(err.message));
    }
    if (!auth.isConnected()) { isMod = null; modCheckedAt = null; }
  }

  /** Fehlende Rechte des Bots in einem Kanal (deutsche Namen). null = Kanal nicht gefunden. */
  function missingPermissions(channelId) {
    if (!channelId || !client.isReady()) return null;
    const channel = client.channels.cache.get(channelId);
    if (!channel?.permissionsFor) return null;
    const perms = channel.permissionsFor(client.user);
    if (!perms) return null;
    return BRIDGE_PERMISSIONS.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
  }

  function status() {
    return {
      running,
      connection,
      error: lastError,
      channel: broadcaster?.login ?? broadcasterLogin,
      isMod,
      modCheckedAt,
      stats: { ...stats },
      queued: { toTwitch: twitchQueue.length, toDiscord: discordPending },
    };
  }

  auth.onChange(() => {
    broadcaster = broadcaster && auth.isConnected() ? broadcaster : null;
    reconcile();
    if (auth.isConnected()) refreshModStatus();
  });

  return {
    reconcile,
    status,
    refreshModStatus,
    missingPermissions,
    handleDiscordMessage,
    handleDiscordDelete,
    stop,
  };
}
