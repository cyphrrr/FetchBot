// npm test — Ablauf der Chat-Brücke gegen ein simuliertes Twitch (HTTP + EventSub-
// WebSocket) und einen nachgebauten Discord-Client. Kein echtes Netzwerk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOT_ID = '900';
const BROADCASTER_ID = '100';
const CHANNEL_ID = '200000000000000001';

// ---------------- simuliertes Twitch ----------------
const twitch = {
  subscriptions: [],
  sent: [],         // Bodies von POST /chat/messages
  deleted: [],      // message_ids von DELETE /moderation/chat
  nextSendResult: null,
  tokenCalls: [],
  msgCounter: 0,
};

function json(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method ?? 'GET';
  if (u.host === 'id.twitch.tv') {
    if (u.pathname === '/oauth2/token') {
      const p = new URLSearchParams(opts.body);
      twitch.tokenCalls.push(p.get('grant_type'));
      if (p.get('grant_type') === 'authorization_code') {
        assert.equal(p.get('redirect_uri'), 'https://napoli.ratioed.live/twitch/callback');
        return json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 14000, scope: [] });
      }
      return json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 14000, scope: [] });
    }
    if (u.pathname === '/oauth2/validate') {
      return json({ user_id: BOT_ID, login: 'post_von_napoli', scopes: ['user:read:chat', 'user:write:chat', 'user:read:moderated_channels', 'moderator:manage:chat_messages'] });
    }
    if (u.pathname === '/oauth2/revoke') return json(null, 200);
  }
  if (u.host === 'api.twitch.tv') {
    const path = u.pathname.replace('/helix', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (path === '/users' && u.searchParams.get('login')) return json({ data: [{ id: BROADCASTER_ID, login: 'napoli', display_name: 'Napoli' }] });
    if (path === '/users' && u.searchParams.get('id')) return json({ data: [{ id: u.searchParams.get('id'), profile_image_url: 'https://img/' + u.searchParams.get('id') }] });
    if (path === '/moderation/channels') return json({ data: [{ broadcaster_id: BROADCASTER_ID }], pagination: {} });
    if (path === '/eventsub/subscriptions' && method === 'POST') { twitch.subscriptions.push(body); return json({ data: [] }, 202); }
    if (path === '/chat/messages' && method === 'POST') {
      twitch.sent.push(body);
      if (twitch.nextSendResult) { const r = twitch.nextSendResult; twitch.nextSendResult = null; return json(r); }
      return json({ data: [{ message_id: 'tw-out-' + (++twitch.msgCounter), is_sent: true }] });
    }
    if (path === '/moderation/chat' && method === 'DELETE') { twitch.deleted.push(u.searchParams.get('message_id')); return json(null, 204); }
  }
  throw new Error('unerwarteter fetch: ' + method + ' ' + url);
};

class FakeWebSocket {
  static instances = [];
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; FakeWebSocket.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(obj) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(obj) }); }
  close() { this.closed = true; for (const fn of this.listeners.close ?? []) fn({ code: 1000, reason: '' }); }
}
globalThis.WebSocket = FakeWebSocket;

// ---------------- nachgebautes Discord ----------------
const discord = { sent: [], deleted: [], reactions: [] };
let mirrorCounter = 0;
const hook = {
  owner: { id: 'discord-bot' }, name: 'Napoli Chat-Brücke', token: 'hooktoken',
  async send(payload) { discord.sent.push(payload); return { id: 'mirror-' + (++mirrorCounter) }; },
  async deleteMessage(id) { discord.deleted.push(id); },
};
const channel = {
  name: 'stream-chat',
  async fetchWebhooks() { return [hook]; },
  async createWebhook() { return hook; },
  permissionsFor() { return { has: () => true }; },
};
const client = {
  isReady: () => true,
  user: { id: 'discord-bot' },
  channels: { fetch: async (id) => (id === CHANNEL_ID ? channel : null), cache: { get: (id) => (id === CHANNEL_ID ? channel : undefined) } },
};

function discordMessage(id, text, extra = {}) {
  return {
    id, channelId: CHANNEL_ID, guild: {}, system: false, webhookId: null,
    author: { id: 'u-lena', bot: false, username: 'lena', globalName: 'Lena' },
    member: { displayName: 'Lena' },
    cleanContent: text, reference: null,
    async react(e) { discord.reactions.push([id, e]); },
    ...extra,
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let notifCounter = 0;
const notification = (subscription_type, event, id = 'n-' + (++notifCounter)) => ({
  metadata: { message_type: 'notification', message_id: id, subscription_type },
  payload: { event },
});
const chatEvent = (message_id, chatter, text, extra = {}) => ({
  broadcaster_user_id: BROADCASTER_ID, chatter_user_id: chatter.id, chatter_user_login: chatter.login,
  chatter_user_name: chatter.name, message_id, message: { text, fragments: [{ type: 'text', text }] }, ...extra,
});
const KAFFEE = { id: '555', login: 'kaffeejunkie', name: 'kaffeejunkie' };

// Module erst nach dem Mocken laden.
const { createTwitchAuth } = await import('../twitch-auth.js');
const { createChatBridge } = await import('../chat-bridge.js');

const dir = mkdtempSync(join(tmpdir(), 'napoli-bridge-'));
const tokenFile = join(dir, 'twitch-bridge-token.json');
const silent = () => {};
const auth = createTwitchAuth({
  clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://napoli.ratioed.live/twitch/callback',
  tokenFile, log: silent, logError: silent,
});
let bridgeSettings = { enabled: true, channelId: CHANNEL_ID };
const bridge = createChatBridge({ client, auth, broadcasterLogin: 'napoli', getSettings: () => bridgeSettings, log: silent, logError: silent });

test('Login: ungültiger state wird abgelehnt', async () => {
  await assert.rejects(auth.handleCallback({ code: 'x', state: 'falsch' }), (err) => err.httpStatus === 400);
  assert.equal(auth.isConnected(), false);
});

test('Login: Code gegen Token tauschen, Datei mit 0600, state nur einmal gültig', async () => {
  const url = new URL(auth.authorizeUrl());
  assert.equal(url.searchParams.get('redirect_uri'), 'https://napoli.ratioed.live/twitch/callback');
  assert.ok(url.searchParams.get('scope').includes('user:write:chat'));
  const state = url.searchParams.get('state');
  const { login } = await auth.handleCallback({ code: 'abc', state });
  assert.equal(login, 'post_von_napoli');
  assert.ok(existsSync(tokenFile));
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(auth.info().missingScopes, []);
  await assert.rejects(auth.handleCallback({ code: 'abc', state }), (err) => err.httpStatus === 400);
});

test('Brücke startet, verbindet EventSub und abonniert 3 Events', async () => {
  await tick(); // onChange -> reconcile -> start
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'kein WebSocket geöffnet');
  ws.emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess-1', keepalive_timeout_seconds: 10 } } });
  await tick();
  assert.deepEqual(twitch.subscriptions.map((s) => s.type).sort(), ['channel.chat.clear_user_messages', 'channel.chat.message', 'channel.chat.message_delete']);
  for (const s of twitch.subscriptions) {
    assert.equal(s.transport.session_id, 'sess-1');
    assert.deepEqual(s.condition, { broadcaster_user_id: BROADCASTER_ID, user_id: BOT_ID });
  }
  assert.equal(bridge.status().connection, 'verbunden');
  assert.equal(bridge.status().isMod, true);
});

test('Twitch -> Discord: Webhook mit Name (Twitch), Avatar, ohne Pings', async () => {
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit(notification('channel.chat.message', chatEvent('tw-in-1', KAFFEE, 'Moin! Was zocken wir heute?')));
  await tick();
  const p = discord.sent.at(-1);
  assert.equal(p.content, 'Moin! Was zocken wir heute?');
  assert.equal(p.username, 'kaffeejunkie (Twitch)');
  assert.equal(p.avatarURL, 'https://img/555');
  assert.deepEqual(p.allowedMentions, { parse: [], users: [] });
});

test('Schleifenschutz: eigene Bot-Nachrichten auf Twitch werden nicht gespiegelt', async () => {
  const before = discord.sent.length;
  FakeWebSocket.instances.at(-1).emit(notification('channel.chat.message', chatEvent('tw-self', { id: BOT_ID, login: 'post_von_napoli', name: 'post_von_napoli' }, 'Lena (Discord): hi')));
  await tick();
  assert.equal(discord.sent.length, before);
});

test('Doppelt zugestellte EventSub-Nachricht wird nur einmal gespiegelt', async () => {
  const before = discord.sent.length;
  const n = notification('channel.chat.message', chatEvent('tw-dup', KAFFEE, 'einmal'), 'same-id');
  FakeWebSocket.instances.at(-1).emit(n);
  FakeWebSocket.instances.at(-1).emit(n);
  await tick();
  assert.equal(discord.sent.length, before + 1);
});

test('Discord -> Twitch: "Lena (Discord): …" als Bot, Webhooks/Bots ignoriert', async () => {
  bridge.handleDiscordMessage(discordMessage('d-1', 'Hab den Stream grad nicht offen, läuft was Gutes?'));
  bridge.handleDiscordMessage(discordMessage('d-hook', 'Webhook-Echo', { webhookId: 'w' }));
  bridge.handleDiscordMessage(discordMessage('d-bot', 'Bot', { author: { id: 'b', bot: true, username: 'b' } }));
  bridge.handleDiscordMessage(discordMessage('d-other', 'anderer Kanal', { channelId: '999999999999999' }));
  bridge.handleDiscordMessage(discordMessage('d-empty', '')); // nur Anhang
  await tick();
  assert.equal(twitch.sent.length, 1);
  assert.deepEqual(twitch.sent[0], { broadcaster_id: BROADCASTER_ID, sender_id: BOT_ID, message: 'Lena (Discord): Hab den Stream grad nicht offen, läuft was Gutes?' });
});

test('Twitch -> Discord: @Lena wird echte Erwähnung (Lena hat im Kanal geschrieben)', async () => {
  FakeWebSocket.instances.at(-1).emit(notification('channel.chat.message', chatEvent('tw-in-2', KAFFEE, '@Lena Heute Wörtchen-Turnier, kommt rein!')));
  await tick();
  const p = discord.sent.at(-1);
  assert.equal(p.content, '<@u-lena> Heute Wörtchen-Turnier, kommt rein!');
  assert.deepEqual(p.allowedMentions.users, ['u-lena']);
});

test('Discord-Antwort auf gespiegelte Twitch-Nachricht wird echte Twitch-Antwort', async () => {
  bridge.handleDiscordMessage(discordMessage('d-2', 'Bin dabei', { reference: { messageId: 'mirror-1' } }));
  await tick();
  assert.equal(twitch.sent.at(-1).reply_parent_message_id, 'tw-in-1');
});

test('Lange Discord-Nachricht wird aufgeteilt', async () => {
  const before = twitch.sent.length;
  bridge.handleDiscordMessage(discordMessage('d-long', Array.from({ length: 150 }, (_, i) => 'wort' + i).join(' ')));
  await tick(80);
  const parts = twitch.sent.slice(before);
  assert.ok(parts.length >= 2);
  for (const p of parts) { assert.ok(p.message.length <= 500); assert.ok(p.message.startsWith('Lena (Discord): ')); }
});

test('Twitch verwirft (AutoMod) -> 🚫 an der Discord-Nachricht', async () => {
  twitch.nextSendResult = { data: [{ message_id: '', is_sent: false, drop_reason: { code: 'automod_held', message: 'held' } }] };
  bridge.handleDiscordMessage(discordMessage('d-auto', 'böses wort'));
  await tick();
  assert.deepEqual(discord.reactions.at(-1), ['d-auto', '🚫']);
});

test('Twitch-Mod löscht -> Discord-Kopie verschwindet', async () => {
  FakeWebSocket.instances.at(-1).emit(notification('channel.chat.message_delete', { message_id: 'tw-in-1' }));
  await tick();
  assert.ok(discord.deleted.includes('mirror-1'));
});

test('Ban/Timeout auf Twitch -> alle Discord-Kopien der Person verschwinden', async () => {
  FakeWebSocket.instances.at(-1).emit(notification('channel.chat.clear_user_messages', { target_user_id: KAFFEE.id }));
  await tick();
  for (const id of ['mirror-2', 'mirror-3']) assert.ok(discord.deleted.includes(id), id + ' nicht gelöscht');
});

test('Discord-Nachricht gelöscht -> Twitch-Kopie wird gelöscht (Bot ist Mod)', async () => {
  bridge.handleDiscordDelete({ id: 'd-1' });
  await tick();
  assert.deepEqual(twitch.deleted, ['tw-out-1']);
});

test('Twitch-Reconnect: neue Verbindung übernimmt, ohne neu zu abonnieren', async () => {
  const old = FakeWebSocket.instances.at(-1);
  const subsBefore = twitch.subscriptions.length;
  old.emit({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://reconnect.example/ws' } } });
  const neu = FakeWebSocket.instances.at(-1);
  assert.notEqual(neu, old);
  assert.equal(neu.url, 'wss://reconnect.example/ws');
  neu.emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess-2', keepalive_timeout_seconds: 10 } } });
  await tick();
  assert.equal(old.closed, true);
  assert.equal(twitch.subscriptions.length, subsBefore);
  const before = discord.sent.length;
  neu.emit(notification('channel.chat.message', chatEvent('tw-in-9', KAFFEE, 'noch da?')));
  await tick();
  assert.equal(discord.sent.length, before + 1);
});

test('Brücke im Panel aus -> stoppt; wieder an -> verbindet neu', async () => {
  bridgeSettings = { enabled: false, channelId: CHANNEL_ID };
  bridge.reconcile();
  assert.equal(bridge.status().running, false);
  assert.equal(FakeWebSocket.instances.at(-1).closed, true);
  bridgeSettings = { enabled: true, channelId: CHANNEL_ID };
  const count = FakeWebSocket.instances.length;
  bridge.reconcile();
  await tick();
  assert.equal(FakeWebSocket.instances.length, count + 1);
});

test('Twitch-Antwort auf Brücken-Nachricht erwähnt die Discord-Person', async () => {
  // Brücke wurde im Test davor neu gestartet (Zuordnungen geleert): erst verbinden,
  // dann schreibt Lena etwas, Mo antwortet auf Twitch darauf.
  const ws = FakeWebSocket.instances.at(-1);
  await tick();
  ws.emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess-3', keepalive_timeout_seconds: 10 } } });
  await tick();
  bridge.handleDiscordMessage(discordMessage('d-r', 'Wer kommt mit?'));
  await tick();
  const outId = 'tw-out-' + twitch.msgCounter;
  ws.emit(notification('channel.chat.message', chatEvent('tw-in-r', { id: '777', login: 'mo', name: 'Mo' }, '@post_von_napoli super', {
    message: { text: '@post_von_napoli super', fragments: [{ type: 'mention', text: '@post_von_napoli', mention: { user_login: 'post_von_napoli' } }, { type: 'text', text: ' super' }] },
    reply: { parent_message_id: outId, parent_user_id: BOT_ID, parent_user_login: 'post_von_napoli', parent_user_name: 'post_von_napoli' },
  })));
  await tick();
  const p = discord.sent.at(-1);
  assert.equal(p.content, '<@u-lena> super');
  assert.deepEqual(p.allowedMentions.users, ['u-lena']);
});

test('Echte Twitch-Erwähnung (@twitchuser) wird nie zur Discord-Erwähnung', async () => {
  // Lena heißt in Discord "Lena". Ein Twitch-User "lena" erwähnt -> kein Ping in Discord.
  FakeWebSocket.instances.at(-1).emit(notification('channel.chat.message', chatEvent('tw-in-m', KAFFEE, '@lena hi', {
    message: { text: '@lena hi', fragments: [{ type: 'mention', text: '@lena', mention: { user_login: 'lena' } }, { type: 'text', text: ' hi' }] },
  })));
  await tick();
  assert.deepEqual(discord.sent.at(-1).allowedMentions.users, []);
});

test('Rate-Limit 429: nach 3 Versuchen verwerfen statt endlos', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/chat/messages')) { calls++; return new Response('{}', { status: 429 }); }
    return origFetch(url, opts);
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 5000 ? 1 : ms, ...a); // 5s-Pausen abkürzen
  try {
    bridge.handleDiscordMessage(discordMessage('d-429', 'zu schnell'));
    await tick(100);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 4);
  assert.deepEqual(discord.reactions.at(-1), ['d-429', '⚠️']);
});

test('Schnell aus/an: nur EINE aktive Verbindung, alter Welcome wird verworfen', async () => {
  const subsBefore = twitch.subscriptions.length;
  const count = FakeWebSocket.instances.length;
  bridgeSettings = { enabled: false, channelId: CHANNEL_ID }; bridge.reconcile();
  bridgeSettings = { enabled: true, channelId: CHANNEL_ID }; bridge.reconcile();
  bridgeSettings = { enabled: false, channelId: CHANNEL_ID }; bridge.reconcile();
  bridgeSettings = { enabled: true, channelId: CHANNEL_ID }; bridge.reconcile();
  await tick(60);
  const opened = FakeWebSocket.instances.slice(count);
  assert.equal(opened.length, 1, 'mehr als eine neue Verbindung');
  opened[0].emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess-x', keepalive_timeout_seconds: 10 } } });
  await tick();
  assert.equal(twitch.subscriptions.length, subsBefore + 3);
  assert.equal(bridge.status().connection, 'verbunden');
});

test('Reconnect-Socket nach Stopp übernimmt nicht (Status bleibt aus)', async () => {
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://r2.example/ws' } } });
  const pending = FakeWebSocket.instances.at(-1);
  bridgeSettings = { enabled: false, channelId: CHANNEL_ID }; bridge.reconcile();
  pending.emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess-late', keepalive_timeout_seconds: 10 } } });
  await tick();
  assert.equal(bridge.status().running, false);
  assert.equal(bridge.status().connection, 'aus');
  assert.equal(pending.closed, true);
  bridgeSettings = { enabled: true, channelId: CHANNEL_ID }; bridge.reconcile();
  await tick();
});

test('Trennen: Token weg, Brücke stoppt', async () => {
  await auth.disconnect();
  await tick();
  assert.equal(auth.isConnected(), false);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(bridge.status().running, false);
});
