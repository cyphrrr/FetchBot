// Laden, Validieren und Speichern der Textbefehle (commands.json).
// Eigenes Modul, damit Bot (index.js) und Admin-Panel (admin.js) dieselben
// Regeln benutzen und nie auseinanderlaufen.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Timing-sicherer Stringvergleich (über SHA-256, damit Längen gleich sind). */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export const NAME_RULE = /^[a-z0-9_-]{1,32}$/;
// Platzhalter in replies, wird durch die Erwähnung des angegebenen Users ersetzt.
export const TARGET_TOKEN = '{ziel}';
export const TARGET_OPTION = 'wen';

// Für das Panel, damit Client- und Server-Validierung dieselbe Quelle haben.
export const RULES = {
  nameRule: NAME_RULE.source,
  nameMax: 32,
  descriptionMax: 100,
  replyMax: 1900,
  targetToken: TARGET_TOKEN,
};

/** Prüft einen einzelnen Eintrag. Gibt eine deutsche Fehlermeldung zurück oder null. */
export function validateEntry(name, entry) {
  const usesTarget =
    Array.isArray(entry?.replies) &&
    entry.replies.some((r) => typeof r === 'string' && r.includes(TARGET_TOKEN));

  if (!NAME_RULE.test(name)) return 'Name nur a-z 0-9 _ - und max 32 Zeichen';
  if (typeof entry?.description !== 'string' || entry.description.length < 1 || entry.description.length > 100)
    return 'Beschreibung fehlt oder länger als 100 Zeichen';
  if (!Array.isArray(entry.replies) || entry.replies.length === 0) return 'replies fehlt oder ist leer';
  if (entry.replies.some((r) => typeof r !== 'string' || !r.trim())) return 'replies enthält leere Einträge';
  if (entry.replies.some((r) => r.length > RULES.replyMax)) return `Antworten dürfen max ${RULES.replyMax} Zeichen haben`;
  // Sonst stünde der Platzhalter wörtlich in der Antwort.
  if (usesTarget && entry.target !== true) return `${TARGET_TOKEN} benutzt, aber "target": true fehlt`;
  // Sonst müsste man beim Aufruf jemanden angeben, ohne dass er vorkommt.
  if (entry.target === true && !usesTarget) return `"target": true gesetzt, aber ${TARGET_TOKEN} kommt in keiner Antwort vor`;
  return null;
}

/** Reduziert einen Eintrag auf die bekannten Felder — hält Fremdes aus der Datei raus. */
export function normalizeEntry(entry) {
  const clean = {
    description: entry.description,
    ...(entry.target === true && { target: true }),
    replies: entry.replies.map((r) => String(r)),
  };
  return clean;
}

/**
 * Liest die Datei und gibt nur die gültigen Einträge zurück.
 * Ungültige landen als Meldungen in errors — Discord würde sonst wegen eines
 * einzigen kaputten Befehls die GESAMTE Registrierung ablehnen.
 */
export function loadCommands(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { commands: {}, errors: [`${file} nicht lesbar (${err.message})`] };
  }

  const commands = {};
  const errors = [];
  for (const [name, entry] of Object.entries(raw)) {
    const problem = validateEntry(name, entry);
    if (problem) {
      errors.push(`"${name}" übersprungen: ${problem}`);
      continue;
    }
    commands[name] = normalizeEntry(entry);
  }
  return { commands, errors };
}

/**
 * Validiert ALLE Einträge und schreibt die Datei. Wirft bei ungültigen Daten,
 * es landet also nie Schrott auf der Platte.
 * Schreibt erst eine Temp-Datei und benennt um (atomar). Fällt auf direktes
 * Schreiben zurück, falls die Datei ein einzelner Bind-Mount ist (EBUSY).
 */
export function saveCommands(file, commands) {
  for (const [name, entry] of Object.entries(commands)) {
    const problem = validateEntry(name, entry);
    if (problem) throw new Error(`"${name}": ${problem}`);
  }

  const json = JSON.stringify(commands, null, 2) + '\n';
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, json, 'utf8');
  }
}
