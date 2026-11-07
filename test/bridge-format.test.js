// npm test — reine Text-Umwandlung der Chat-Brücke, ohne Netzwerk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  twitchToDiscord, webhookUsername, discordToTwitchText, twitchPrefix, splitForTwitch,
  nameKey, BoundedMap, TWITCH_MAX,
} from '../bridge-format.js';

const ev = (fragments, extra = {}) => ({ message: { text: fragments.map((f) => f.text).join(''), fragments }, ...extra });

test('Twitch -> Discord: Text, Emotes, GIF fällt weg', () => {
  const { content } = twitchToDiscord(ev([
    { type: 'text', text: 'Moin ' },
    { type: 'emote', text: 'Kappa' },
    { type: 'text', text: ' ' },
    { type: 'gif', text: 'irgendwas.gif' },
  ]));
  assert.equal(content, 'Moin Kappa');
});

test('Twitch -> Discord: Markdown und maskierte Links werden entschärft', () => {
  const { content } = twitchToDiscord(ev([{ type: 'text', text: '**fett** [klick](https://evil.example) ||spoiler||' }]));
  assert.ok(!content.includes('**fett**'));
  assert.ok(content.includes('\\*\\*fett\\*\\*'));
  assert.ok(content.includes('\\[klick\\]') || content.includes('\\[klick]'));
  assert.ok(content.includes('\\|\\|spoiler\\|\\|'));
});

test('Twitch -> Discord: @Name wird zur Discord-Erwähnung, wenn bekannt', () => {
  const resolve = (name) => (nameKey(name) === 'lena' ? '111111111111' : null);
  const { content, mentionIds } = twitchToDiscord(ev([{ type: 'text', text: '@Lena Heute Turnier, @Unbekannt auch' }]), resolve);
  assert.equal(content, '<@111111111111> Heute Turnier, @Unbekannt auch');
  assert.deepEqual(mentionIds, ['111111111111']);
});

test('Twitch -> Discord: @everyone pingt nicht (bleibt Text, keine ID)', () => {
  const { content, mentionIds } = twitchToDiscord(ev([{ type: 'text', text: '@everyone hallo' }]));
  assert.equal(content, '@everyone hallo');
  assert.deepEqual(mentionIds, []);
});

test('Twitch -> Discord: Antwort ohne @-Präfix bekommt eins', () => {
  const { content } = twitchToDiscord(ev([{ type: 'text', text: 'stimmt' }], {
    reply: { parent_user_name: 'Mo', parent_user_login: 'mo' },
  }));
  assert.equal(content, '@Mo stimmt');
  const { content: c2 } = twitchToDiscord(ev([{ type: 'mention', text: '@mo' }, { type: 'text', text: ' stimmt' }], {
    reply: { parent_user_name: 'Mo', parent_user_login: 'mo' },
  }));
  assert.equal(c2, '@mo stimmt');
});

test('Twitch -> Discord: nur GIF = nichts senden', () => {
  assert.equal(twitchToDiscord(ev([{ type: 'gif', text: 'x' }])).content, '');
});

test('Webhook-Name: Suffix, verbotene Wörter, Länge', () => {
  assert.equal(webhookUsername('kaffeejunkie'), 'kaffeejunkie (Twitch)');
  assert.equal(webhookUsername('DiscordFan'), 'dcFan (Twitch)');
  assert.equal(webhookUsername('clyde99'), 'c1yde99 (Twitch)');
  assert.ok(webhookUsername('x'.repeat(200)).length <= 80);
});

test('Discord -> Twitch: Emojis, Spoiler, Zeilen', () => {
  assert.equal(discordToTwitchText('Bin dabei <:napoliHype:123456789>\nbis gleich'), 'Bin dabei :napoliHype: bis gleich');
  assert.equal(discordToTwitchText('Ende: ||er stirbt|| lol'), 'Ende: [Spoiler] lol');
  assert.equal(discordToTwitchText('   '), '');
});

test('Präfix-Format: "Lena (Discord): "', () => {
  assert.equal(twitchPrefix('Lena'), 'Lena (Discord): ');
});

test('Aufteilen: kurze Nachricht bleibt ein Teil', () => {
  assert.deepEqual(splitForTwitch('Lena (Discord): ', 'Hallo Welt'), ['Lena (Discord): Hallo Welt']);
});

test('Aufteilen: lange Nachricht in mehrere Teile, alle <= 500 und mit Präfix', () => {
  const text = Array.from({ length: 200 }, (_, i) => `wort${i}`).join(' ');
  const parts = splitForTwitch('Lena (Discord): ', text);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= TWITCH_MAX, `Teil zu lang: ${p.length}`);
    assert.ok(p.startsWith('Lena (Discord): '));
  }
  // Nichts verloren gegangen (bei <= 5 Teilen)
  assert.equal(parts.map((p) => p.slice('Lena (Discord): '.length)).join(' '), text);
});

test('Aufteilen: überlanges Wort wird hart geteilt', () => {
  const link = 'https://example.com/' + 'a'.repeat(1200);
  const parts = splitForTwitch('Mo (Discord): ', link);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= TWITCH_MAX);
});

test('Aufteilen: mehr als 5 Teile -> abgeschnitten mit …', () => {
  const text = 'x '.repeat(3000).trim();
  const parts = splitForTwitch('Mo (Discord): ', text);
  assert.equal(parts.length, 5);
  assert.ok(parts[4].endsWith('…'));
  assert.ok(parts[4].length <= TWITCH_MAX);
});

test('BoundedMap wirft den ältesten Eintrag raus', () => {
  const m = new BoundedMap(2);
  m.set('a', 1); m.set('b', 2); m.set('c', 3);
  assert.deepEqual([...m.keys()], ['b', 'c']);
});

test('Twitch -> Discord: führendes # nach Einrückung wird keine Überschrift', () => {
  assert.equal(twitchToDiscord(ev([{ type: 'text', text: '   # Titel' }])).content, '\\# Titel');
});

test('Kürzen zerteilt keine Emojis', () => {
  const parts = splitForTwitch('Mo (Discord): ', '😀'.repeat(400));
  for (const p of parts) assert.ok(!/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p.slice('Mo (Discord): '.length)));
});

test('Antwort an Namen mit Unterstrich: @-Präfix nicht doppelt', () => {
  const { content } = twitchToDiscord(ev([{ type: 'mention', text: '@post_von_napoli', mention: { user_login: 'post_von_napoli' } }, { type: 'text', text: ' super' }], {
    reply: { parent_user_name: 'post_von_napoli', parent_user_login: 'post_von_napoli' },
  }));
  assert.equal(content, '@post\\_von\\_napoli super');
});

