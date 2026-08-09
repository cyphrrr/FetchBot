// Emoji-Vergleich für die Reaction-Role (Themenwoche). Eigenes Modul, damit die
// Logik ohne den laufenden Bot testbar bleibt (index.js hat Start-Nebenwirkungen).
//
// Discord kennt zwei Sorten: Unicode-Emojis (🎓) und Server-Custom-Emojis
// (<:name:id> bzw. animiert <a:name:id>). Im Reaction-Event hat ein Custom-Emoji
// eine id, ein Unicode-Emoji nicht (id === null, name === das Zeichen selbst).

/**
 * Zerlegt ein konfiguriertes Emoji in Custom (<:name:id> / <a:name:id> / name:id)
 * oder Unicode. Rückgabe: { custom, id, name }.
 */
export function parseEmoji(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^<a?:([^:]+):(\d+)>$/) || s.match(/^([^:]+):(\d+)$/);
  if (m) return { custom: true, id: m[2], name: m[1] };
  return { custom: false, id: null, name: s };
}

/**
 * true, wenn das Reaction-Emoji aus dem Event zum konfigurierten passt.
 * Custom wird über die ID verglichen (Name kann umbenannt werden), Unicode über
 * das Zeichen. reactionEmoji ist Discords ReactionEmoji mit { id, name }.
 */
export function emojiMatches(reactionEmoji, configured) {
  const c = parseEmoji(configured);
  if (c.custom) return reactionEmoji.id === c.id;
  return reactionEmoji.id == null && reactionEmoji.name === c.name;
}
