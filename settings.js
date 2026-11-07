// Laufzeit-Einstellungen (Live-Ansage-Mention + Rollenverteiler + Chat-Brücke). Liegt als
// settings.json im data/-Mount neben commands.json und überlebt damit Rebuilds.
// Erweiterbar: weitere Felder einfach in normalizeSettings ergänzen.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEmoji } from './emoji.js';

export const MENTION_OFF = 'off';
export const MENTION_EVERYONE = 'everyone';

/** Prüft/normalisiert die Mention: 'off' | 'everyone' | Rollen-ID. Wirft bei Unfug. */
export function normalizeMention(value) {
  if (value == null || value === '' || value === MENTION_OFF) return MENTION_OFF;
  if (value === MENTION_EVERYONE) return MENTION_EVERYONE;
  const str = String(value).trim();
  if (/^\d{5,25}$/.test(str)) return str; // Discord-Rollen-ID (Snowflake)
  throw new Error('Mention muss "off", "everyone" oder eine Rollen-ID (nur Ziffern) sein');
}

// --- Rollenverteiler (Reaction-Roles) ---
// Ein Verteiler = eine Nachricht mit mehreren Emoji→Rolle-Zuordnungen. Mehrere
// Verteiler leben als Liste in settings.roleDistributors. Ein Verteiler:
//   { id, name, channelId, messageId, title, text, mappings:[{emoji, roleId}] }
// Discord-Limits als Obergrenze: Embed-Titel 256, Beschreibung 4096 (Puffer 4000).
const DIST_LIMITS = { name: 100, channelId: 200, messageId: 200, title: 256, text: 4000, emoji: 200, roleId: 200 };

// Neutrale Vorlage, falls beim Migrieren einer alten Einzel-Config kein eigener
// Titel/Text vorlag. {emoji} wird dabei fest eingesetzt. Betrifft nur Uralt-
// Installs; frische Deployments sehen das nie.
const LEGACY_TITLE = 'Rollen-Auswahl';
const LEGACY_TEXT =
  'Reagiere mit {emoji} auf diese Nachricht, um die Rolle zu bekommen.\n\n' +
  'Reaktion wieder entfernen nimmt die Rolle weg.';

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
function newDistId() { return 'd_' + randomBytes(8).toString('hex'); }

/**
 * Emoji→Rolle-Zuordnungen. Unvollständige (Emoji oder Rolle leer) und doppelte
 * (gleiches Emoji) fliegen raus — sonst würde die zweite Zeille nie greifen.
 */
export function normalizeMappings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const emoji = str(m.emoji, DIST_LIMITS.emoji);
    const roleId = str(m.roleId, DIST_LIMITS.roleId);
    if (!emoji || !roleId) continue;
    const p = parseEmoji(emoji);
    const key = p.custom ? `c:${p.id}` : `u:${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ emoji, roleId });
  }
  return out;
}

/**
 * Ein Rollenverteiler. Bewusst tolerant (getrimmte Strings, Länge gekappt) — die
 * echte Prüfung (Kanal/Emoji/Rolle brauchbar?) passiert erst beim Posten bzw. im
 * Reaction-Handler. Fehlt die id, wird eine neue vergeben (bleibt danach stabil).
 */
export function normalizeDistributor(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const id = typeof d.id === 'string' && d.id.trim() ? d.id.trim().slice(0, 64) : newDistId();
  return {
    id,
    name: str(d.name, DIST_LIMITS.name) || 'Rollenverteiler',
    channelId: str(d.channelId, DIST_LIMITS.channelId),
    messageId: str(d.messageId, DIST_LIMITS.messageId),
    title: str(d.title, DIST_LIMITS.title),
    text: str(d.text, DIST_LIMITS.text),
    mappings: normalizeMappings(d.mappings),
  };
}

/** Alte Einzel-Config (settings.reactionRole) -> ein Verteiler "Themenwoche". */
function migrateLegacyReactionRole(rr) {
  const r = rr && typeof rr === 'object' ? rr : {};
  const emoji = r.emoji && r.emoji !== 'EMOJI' ? str(r.emoji, DIST_LIMITS.emoji) : '';
  const roleId = r.roleId && r.roleId !== 'ROLLEN_ID' ? str(r.roleId, DIST_LIMITS.roleId) : '';
  const mappings = emoji && roleId ? [{ emoji, roleId }] : [];
  // {emoji} fest einsetzen, da das Feld im neuen Modell nicht mehr existiert.
  const sub = (s) => String(s).replaceAll('{emoji}', emoji || '🎓');
  return normalizeDistributor({
    name: 'Themenwoche',
    channelId: r.channelId,
    messageId: r.messageId,
    title: sub(r.title != null ? r.title : LEGACY_TITLE),
    text: sub(r.text != null ? r.text : LEGACY_TEXT),
    mappings,
  });
}

/** Liste der Rollenverteiler aus dem Rohobjekt (inkl. Migration der Alt-Config). */
export function normalizeDistributors(rawSettings) {
  const s = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  if (Array.isArray(s.roleDistributors)) return s.roleDistributors.map(normalizeDistributor);
  // Einmalige Migration: alte settings.reactionRole -> ein Verteiler. Nach dem
  // ersten Speichern steht roleDistributors in der Datei, reactionRole verschwindet.
  if (s.reactionRole && typeof s.reactionRole === 'object') return [migrateLegacyReactionRole(s.reactionRole)];
  return [];
}

// --- Chat-Brücke Twitch <-> Discord ---
// { enabled, channelId } — welcher Discord-Kanal mit dem Twitch-Chat verbunden ist.
// Standard: aus. Das Twitch-Token liegt NICHT hier, sondern in twitch-bridge-token.json.

/** Prüft/normalisiert die Brücken-Einstellung. Tolerant, wirft nicht. */
export function normalizeChatBridge(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const channelId = str(b.channelId, 30);
  return {
    enabled: b.enabled === true,
    channelId: /^\d{5,25}$/.test(channelId) ? channelId : '',
  };
}

/** Rohobjekt -> geprüftes Settings-Objekt. */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    mention: normalizeMention(s.mention),
    roleDistributors: normalizeDistributors(s),
    chatBridge: normalizeChatBridge(s.chatBridge),
  };
}

/**
 * Lädt settings.json. Fehlt die Datei, wird aus fallbackMention (dem Env-Default
 * MENTION_ROLE_ID) geseedet. Kaputte Datei oder unbrauchbarer Default -> 'off'
 * plus Fehlermeldung, damit der Bot nie am Start scheitert.
 */
export function loadSettings(file, fallbackMention) {
  // Über normalizeSettings bauen, damit der Fallback IMMER die volle Form hat
  // (inkl. leerer roleDistributors) — sonst wären die Felder beim allerersten
  // Start ohne Datei undefined. normalizeMention ist das Einzige, das werfen kann.
  let fallback;
  try {
    fallback = normalizeSettings({ mention: fallbackMention });
  } catch {
    fallback = normalizeSettings({ mention: MENTION_OFF });
  }

  if (!existsSync(file)) return { settings: fallback, error: null };

  try {
    return { settings: normalizeSettings(JSON.parse(readFileSync(file, 'utf8'))), error: null };
  } catch (err) {
    return { settings: fallback, error: `settings.json unlesbar oder ungültig: ${err.message}` };
  }
}

/** Schreibt atomar (tmp + rename), Fallback direkt. Gibt das geprüfte Objekt zurück. */
export function saveSettings(file, settings) {
  const clean = normalizeSettings(settings);
  const json = JSON.stringify(clean, null, 2);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, json);
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, json);
  }
  return clean;
}
