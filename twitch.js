// Twitch-Integration: App-Access-Token + Stream-Abfrage (für /live) und das
// Live-Embed (für /live und den /notify-Endpoint). Eigenes Modul, damit index.js
// schlank bleibt und der Twitch-Teil klar als optionale Integration abgetrennt ist —
// ohne die drei TWITCH_*-Werte wird hier gar nichts erzeugt.
import { EmbedBuilder } from 'discord.js';

const TWITCH_PURPLE = 0x9146ff;

/** Hex-String ("#rrggbb" | "rrggbb" | "0xrrggbb") -> int, sonst fallback. */
export function parseHexColor(input, fallback) {
  if (!input) return fallback;
  const hex = String(input).trim().replace(/^#/, '').replace(/^0x/i, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? Number.parseInt(hex, 16) : fallback;
}

/**
 * Kapselt Token- und Stream-Cache für genau EINEN Twitch-Kanal. getToken() hält den
 * App-Access-Token (Client-Credentials) bis kurz vor Ablauf im Speicher; fetchStream()
 * cacht die Live-Abfrage 60s gegen Rate-Limits bei /live-Spam.
 */
export function createTwitchClient({ clientId, clientSecret, login }) {
  let tokenCache = { token: null, expiresAt: 0 };
  let streamCache = { data: undefined, at: 0 };

  async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
    if (!res.ok) throw new Error(`Twitch-Token fehlgeschlagen (HTTP ${res.status})`);

    const json = await res.json();
    // 60s Sicherheitsabstand, damit kein Request auf einen gerade abgelaufenen Token trifft.
    tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
    return tokenCache.token;
  }

  async function fetchStream() {
    if (Date.now() - streamCache.at < 60_000) return streamCache.data;

    const token = await getToken();
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Twitch-Abfrage fehlgeschlagen (HTTP ${res.status})`);

    const json = await res.json();
    streamCache = { data: json.data?.[0], at: Date.now() };
    return streamCache.data;
  }

  return { getToken, fetchStream };
}

/**
 * Baut das Rich-Embed aus den Stream-Daten.
 *   color: Akzentfarbe als int (Default Twitch-Lila).
 *   text:  optionaler Beschreibungs-Override mit {streamer}-Platzhalter.
 */
export function buildLiveEmbed(
  { streamer, title, game, thumbnailUrl, profileImageUrl, url },
  { color = TWITCH_PURPLE, text = '' } = {},
) {
  const description = (text || '**{streamer}** ist jetzt live auf Twitch!').replaceAll('{streamer}', streamer ?? '');
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title || `${streamer} ist live`)
    .setURL(url)
    .setDescription(description)
    .setTimestamp();

  if (profileImageUrl) embed.setThumbnail(profileImageUrl);
  // Cache-Buster: Twitch liefert unter derselben Thumbnail-URL wechselnde Bilder,
  // Discord würde sonst ein altes Preview aus dem Cache zeigen.
  if (thumbnailUrl) embed.setImage(`${thumbnailUrl}${thumbnailUrl.includes('?') ? '&' : '?'}t=${Date.now()}`);
  if (game) embed.addFields({ name: 'Spielt gerade', value: game, inline: true });

  return embed;
}
