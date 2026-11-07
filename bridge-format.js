// Text-Umwandlung für die Chat-Brücke Twitch <-> Discord. Eigenes Modul ohne
// Nebenwirkungen (wie emoji.js), damit es ohne laufenden Bot testbar bleibt:
// npm test -> test/bridge-format.test.js
//
// Grundsatz: nur Text. GIFs, Bilder, Sticker und Anhänge werden nicht übertragen.
import { escapeMarkdown } from 'discord.js';

// Twitch erlaubt max. 500 Zeichen pro Chatnachricht.
export const TWITCH_MAX = 500;
// Mehr Teile pro Discord-Nachricht schicken wir nicht — sonst flutet eine lange
// Discord-Nachricht den Twitch-Chat. Der Rest wird mit … abgeschnitten.
export const TWITCH_MAX_PARTS = 5;
// Discord-Webhook-Benutzernamen: 1–80 Zeichen.
const WEBHOOK_NAME_MAX = 80;
// So erscheinen Discord-Leute auf Twitch: "Lena (Discord): Text"
export const DISCORD_SUFFIX = ' (Discord)';
// So erscheinen Twitch-Leute in Discord (als Webhook-Name): "kaffeejunkie (Twitch)"
export const TWITCH_SUFFIX = ' (Twitch)';

const ELLIPSIS = '…';

/** Schneidet nach n UTF-16-Einheiten, ohne ein Emoji (Surrogat-Paar) zu zerteilen. */
export function safeCut(str, n) {
  if (n <= 0) return '';
  if (str.length <= n) return str;
  const code = str.charCodeAt(n - 1);
  return str.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** Alle Markdown-Zeichen entschärfen, damit Twitch-Text in Discord wörtlich erscheint. */
function escapeAll(text) {
  return escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true });
}

/** Schlüssel für die Namenssuche: klein, ohne Leerzeichen. "Lena Müller" -> "lenamüller". */
export function nameKey(name) {
  return String(name ?? '').toLowerCase().replace(/\s+/g, '');
}

// @Name im Fließtext. Buchstaben/Ziffern aller Sprachen plus _ . -
const AT_NAME = /@([\p{L}\p{N}_.-]+)/gu;

/**
 * Twitch-Nachricht (EventSub channel.chat.message) -> Discord-Text.
 *
 * - Text, Emotes und Cheermotes werden als Text übernommen (Emote "Kappa" -> "Kappa").
 * - GIF-Fragmente fallen weg (nur Text).
 * - "@Name" im Fließtext wird zur echten Discord-Erwähnung, wenn Name zu jemandem
 *   passt, der kürzlich im Brücken-Kanal geschrieben hat (resolveMention liefert
 *   dann die User-ID). Echte Twitch-Erwähnungen (@twitchuser, Fragment "mention")
 *   bleiben Text — sonst könnte sich jemand in Discord in den Namen des Streamers
 *   umbenennen und alle @streamer-Pings abgreifen.
 * - replyMentionId: Antwort auf eine Brücken-Nachricht (Discord -> Twitch). Dann
 *   wird das führende "@meinbot" durch die Erwähnung der Discord-Person ersetzt.
 * - Alles andere wird Markdown-escaped, damit z.B. maskierte Links nicht gehen.
 *
 * Rückgabe: { content, mentionIds } — content leer = nichts zu senden.
 */
export function twitchToDiscord(event, resolveMention = () => null, { replyMentionId = null } = {}) {
  const mentionIds = new Set();
  const fragments = Array.isArray(event?.message?.fragments) && event.message.fragments.length
    ? event.message.fragments
    : [{ type: 'text', text: String(event?.message?.text ?? '') }];

  // Text eines Stücks mit @Name-Ersetzung, Rest escaped.
  const withMentions = (text) => {
    let out = '';
    let last = 0;
    for (const m of text.matchAll(AT_NAME)) {
      const id = resolveMention(m[1]);
      if (!id) continue;
      out += escapeAll(text.slice(last, m.index)) + `<@${id}>`;
      mentionIds.add(id);
      last = m.index + m[0].length;
    }
    return out + escapeAll(text.slice(last));
  };

  const parentLogin = String(event?.reply?.parent_user_login ?? '').toLowerCase();
  let content = '';
  let first = true;
  for (const f of fragments) {
    if (!f || typeof f.text !== 'string') continue;
    if (f.type === 'gif') continue; // nur Text
    if (f.type === 'mention') {
      const login = String(f.mention?.user_login ?? f.text.replace(/^@/, '')).toLowerCase();
      // Führendes "@bot" einer Antwort auf eine Brücken-Nachricht -> Discord-Person.
      if (first && replyMentionId && login === parentLogin) {
        content += `<@${replyMentionId}>`;
        mentionIds.add(replyMentionId);
      } else {
        content += escapeAll(f.text.startsWith('@') ? f.text : '@' + f.text);
      }
      first = false;
      continue;
    }
    if (first && replyMentionId && parentLogin && f.text.trimStart().toLowerCase().startsWith('@' + parentLogin)) {
      // Manche Clients liefern das "@name" als Text statt als mention-Fragment.
      const rest = f.text.trimStart().slice(parentLogin.length + 1);
      content += `<@${replyMentionId}>` + withMentions(rest);
      mentionIds.add(replyMentionId);
      first = false;
      continue;
    }
    if (f.text.trim()) first = false;
    content += withMentions(f.text);
  }
  content = content.replace(/\s+/g, ' ').trim();

  // Nach dem Trim kann ein "#", ">" oder "-" vorne stehen, das vorher eingerückt
  // (und damit kein Markdown) war — jetzt wäre es Überschrift/Zitat/Liste.
  content = content.replace(/^([#>]|[-*] )/, '\\$1').replace(/^(\d+)\. /, '$1\\. ');

  if (replyMentionId && content && !mentionIds.has(replyMentionId)) {
    content = `<@${replyMentionId}> ${content}`;
    mentionIds.add(replyMentionId);
  }

  // Antwort auf eine andere Nachricht: Twitch setzt "@name " meist schon an den
  // Anfang. Falls nicht, ergänzen wir es, damit der Bezug in Discord sichtbar bleibt.
  const parent = event?.reply?.parent_user_name || event?.reply?.parent_user_login;
  if (content && parent && !replyMentionId) {
    // Vergleich gegen Roh- UND escapte Form ("@mein\\_bot").
    const lower = content.toLowerCase();
    const startsWithParent = [event.reply.parent_user_login, parent].filter(Boolean)
      .some((n) => lower.startsWith('@' + String(n).toLowerCase()) || lower.startsWith(escapeAll('@' + String(n)).toLowerCase()));
    const hasLeadingMention = /^<@\d+>/.test(content);
    if (!startsWithParent && !hasLeadingMention) content = escapeAll('@' + parent) + ' ' + content;
  }

  // Discord-Limit 2000 — Twitch-Nachrichten sind max. 500, Escaping kann aber verlängern.
  if (content.length > 2000) content = safeCut(content, 1999) + ELLIPSIS;
  return { content, mentionIds: [...mentionIds] };
}

/**
 * Webhook-Name für einen Twitch-Chatter. Discord lehnt Namen ab, die "discord"
 * oder "clyde" enthalten oder "everyone"/"here" heißen — die werden entschärft.
 */
export function webhookUsername(displayName) {
  let name = String(displayName ?? '').replace(/\s+/g, ' ').trim() || 'Twitch';
  name = name.replace(/discord/gi, 'dc').replace(/clyde/gi, 'c1yde');
  if (/^(everyone|here)$/i.test(name)) name = `_${name}`;
  const max = WEBHOOK_NAME_MAX - TWITCH_SUFFIX.length;
  if (name.length > max) name = safeCut(name, max - 1) + ELLIPSIS;
  return name + TWITCH_SUFFIX;
}

/**
 * Discord-Nachricht -> reiner Text für Twitch.
 * Erwartet message.cleanContent (Discord hat <@id>, <#id>, <@&id> dann schon in
 * @Name/#kanal umgewandelt).
 *
 * - Server-Emojis <:name:id> -> :name:
 * - Spoiler ||text|| -> [Spoiler] (sonst wäre er auf Twitch offen lesbar)
 * - Zeilenumbrüche -> Leerzeichen (Twitch-Nachrichten sind einzeilig)
 */
export function discordToTwitchText(cleanContent) {
  return String(cleanContent ?? '')
    .replace(/<a?:([\w~-]+):\d+>/g, ':$1:')
    .replace(/\|\|[\s\S]+?\|\|/g, '[Spoiler]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Lena" -> "Lena (Discord): ". Name ohne Umbrüche, sinnvoll gekürzt. */
export function twitchPrefix(displayName) {
  let name = String(displayName ?? '').replace(/\s+/g, ' ').trim() || 'Jemand';
  if (name.length > 40) name = safeCut(name, 39) + ELLIPSIS;
  return `${name}${DISCORD_SUFFIX}: `;
}

/**
 * Teilt Text auf Twitch-taugliche Nachrichten auf. Jeder Teil bekommt das Präfix,
 * damit man auch beim zweiten Teil sieht, von wem er ist. Getrennt wird an
 * Leerzeichen; überlange Wörter (Links) werden hart geteilt.
 * Mehr als maxParts Teile -> der letzte endet mit …
 */
export function splitForTwitch(prefix, text, max = TWITCH_MAX, maxParts = TWITCH_MAX_PARTS) {
  const room = max - prefix.length;
  if (room < 20) throw new Error('Präfix zu lang');
  const words = String(text).split(' ').filter(Boolean);
  const parts = [];
  let cur = '';

  const push = () => { if (cur) parts.push(cur); cur = ''; };
  for (let word of words) {
    while (word.length > room) {
      // Überlanges Wort (z.B. langer Link): aktuelle Zeile abschließen, dann hart schneiden.
      push();
      const piece = safeCut(word, room);
      parts.push(piece);
      word = word.slice(piece.length);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= room) cur += ' ' + word;
    else { push(); cur = word; }
  }
  push();

  if (parts.length > maxParts) {
    const kept = parts.slice(0, maxParts);
    let lastPart = kept[maxParts - 1];
    if (lastPart.length + ELLIPSIS.length > room) lastPart = safeCut(lastPart, room - ELLIPSIS.length);
    kept[maxParts - 1] = lastPart + ELLIPSIS;
    return kept.map((p) => prefix + p);
  }
  return parts.map((p) => prefix + p);
}

/**
 * Kleine Map mit Obergrenze: der älteste Eintrag fliegt raus, wenn sie voll ist.
 * Für die Nachrichten-Zuordnung (Löschen synchronisieren) und Caches.
 */
export class BoundedMap extends Map {
  constructor(limit) { super(); this.limit = limit; }
  set(key, value) {
    if (this.has(key)) this.delete(key); // nach hinten = frisch
    super.set(key, value);
    while (this.size > this.limit) this.delete(this.keys().next().value);
    return this;
  }
}
