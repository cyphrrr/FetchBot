import { Client, GatewayIntentBits, Partials, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ApplicationCommandOptionType } from 'discord.js';
import express from 'express';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCommands, saveCommands, safeEqual, TARGET_TOKEN, TARGET_OPTION } from './store.js';
import { loadSettings, saveSettings, normalizeMention, normalizeDistributor } from './settings.js';
import { emojiMatches } from './emoji.js';
import { createTwitchClient, buildLiveEmbed, parseHexColor } from './twitch.js';
import { createAdminServer } from './admin.js';

// --- Konfiguration (alles über Env, nichts hardcodiert) ---
const {
  DISCORD_BOT_TOKEN,
  // Optional: Ziel-Channel der Live-Ansage (/notify). Nur nötig, wenn der
  // Twitch-Notify-Endpoint genutzt wird — ein reiner Command-/Reaction-Role-Bot
  // läuft auch ohne. Fehlt er, antwortet /notify mit einem klaren Fehler.
  DISCORD_CHANNEL_ID = '',
  HTTP_PORT = '3010',
  // Optional: Start-Default für die Live-Ansage-Mention. "everyone" -> @everyone,
  // sonst eine Rollen-ID. Gilt nur solange keine settings.json existiert — danach
  // gewinnt die im Panel gesetzte Einstellung.
  MENTION_ROLE_ID = '',
  // Optional: ohne Guild-ID werden keine Slash-Befehle registriert.
  DISCORD_GUILD_ID = '',
  // Optional: nur nötig für /live.
  TWITCH_CLIENT_ID = '',
  TWITCH_CLIENT_SECRET = '',
  TWITCH_LOGIN = '',
  // --- Branding (white-label): eigener Name/Emoji/Akzentfarbe pro Deployment ---
  // BRAND_NAME überschreibt den Panel-Titel (leer = der live gelesene Bot-Name).
  // BRAND_EMOJI ist das Icon im Panel-Header/Login. EMBED_COLOR färbt alle Embeds.
  BRAND_NAME = '',
  BRAND_EMOJI = '🤖',
  EMBED_COLOR = '',
  // Optional: user-sichtbare /live-Texte überschreiben ({streamer}-Platzhalter).
  LIVE_OFFLINE_MESSAGE = '',
  LIVE_ERROR_MESSAGE = '',
  LIVE_EMBED_TEXT = '',
  LIVE_BUTTON_LABEL = '',
  // Optional: Admin-Panel. Ohne Passwort bleibt es aus.
  ADMIN_PASSWORD = '',
  ADMIN_PORT = '7855',
  // Optional: nur setzen, wenn das Panel hinter einem Reverse Proxy laeuft.
  // Sonst zaehlt die Login-Bremse alle Anfragen unter der Proxy-IP. Siehe .env.example.
  ADMIN_TRUST_PROXY = '',
  // Optional: schützt /notify. Leer = offen (nur intern erreichbar, siehe README).
  NOTIFY_TOKEN = '',
} = process.env;

// Nur der Bot-Token ist wirklich Pflicht — ohne ihn kann der Bot sich nicht
// verbinden. Alles andere ist optional und schaltet einzelne Features zu.
if (!DISCORD_BOT_TOKEN) {
  console.error('[fatal] Env-Variable DISCORD_BOT_TOKEN fehlt');
  process.exit(1);
}

const ACCENT_COLOR = parseHexColor(EMBED_COLOR, 0x9146ff);

// Textbefehle liegen ausserhalb des Images (data/-Mount), damit Aenderungen
// Rebuilds ueberleben. Fehlt die Datei dort, wird die mitgelieferte kopiert.
const BUNDLED_COMMANDS = fileURLToPath(new URL('./commands.json', import.meta.url));
const COMMANDS_FILE = process.env.COMMANDS_FILE || BUNDLED_COMMANDS;

if (COMMANDS_FILE !== BUNDLED_COMMANDS && !existsSync(COMMANDS_FILE) && existsSync(BUNDLED_COMMANDS)) {
  try {
    mkdirSync(dirname(COMMANDS_FILE), { recursive: true });
    copyFileSync(BUNDLED_COMMANDS, COMMANDS_FILE);
    console.log(`[commands] ${COMMANDS_FILE} aus dem Image initialisiert`);
  } catch (err) {
    console.error(`[commands] Konnte ${COMMANDS_FILE} nicht anlegen: ${err.message}`);
  }
}

// Laufzeit-Einstellungen (Live-Ansage-Mention) neben commands.json. MENTION_ROLE_ID
// aus der .env ist nur der Startwert, solange keine settings.json existiert; danach
// gewinnt die Datei (im Panel änderbar, ohne Rebuild).
const SETTINGS_FILE = process.env.SETTINGS_FILE || join(dirname(COMMANDS_FILE), 'settings.json');
const settingsLoad = loadSettings(SETTINGS_FILE, MENTION_ROLE_ID);
if (settingsLoad.error) console.error(`[settings] ${settingsLoad.error}`);
let settings = settingsLoad.settings;

// /live braucht alle drei Twitch-Werte; fehlt einer, wird der Befehl weggelassen.
const liveEnabled = Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && TWITCH_LOGIN);

// Guilds:               Kanäle/Rollen im Cache (Panel-Dropdowns) + Interactions.
// GuildMessageReactions: liefert die Reaction-Events für die Themenwoche.
// GuildMembers:          privilegiert! Muss im Developer Portal aktiviert sein,
//                        sonst schlägt der Login fehl. Für member.roles.add/remove.
// Message Content brauchen wir weiterhin nicht (der Bot liest keine Nachrichten-Inhalte).
//
// Partials: Reactions treffen auch Nachrichten, die nicht im Cache liegen (z.B. die
// Einschreibungs-Nachricht nach einem Neustart). Ohne Partials würde Discord solche
// Events verschlucken — mit Partials kommen sie an und werden bei Bedarf per fetch()
// nachgeladen (siehe handleReaction).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

/** Fehler mit HTTP-Status, damit eine Panel-Aktion 400/404/503 signalisieren kann. */
function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

const startedAt = Date.now();

// Twitch-Client nur, wenn /live aktiv ist (alle drei TWITCH_*-Werte da). Sonst null.
const twitchClient = liveEnabled
  ? createTwitchClient({ clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET, login: TWITCH_LOGIN })
  : null;

/** Branding fürs Panel (Name/Emoji/Akzentfarbe). Nicht sensibel, auch öffentlich abrufbar. */
function getBrand() {
  return { name: BRAND_NAME, emoji: BRAND_EMOJI, color: `#${ACCENT_COLOR.toString(16).padStart(6, '0')}` };
}

/**
 * Mention-Text + erlaubte Pings, aus der Live-Einstellung (settings.mention).
 * Ohne allowedMentions pingt Discord sonst nichts bzw. zu viel. Wird bei jeder
 * Ansage frisch gelesen, damit Panel-Änderungen ohne Neustart greifen.
 */
function buildMention() {
  const m = settings.mention;
  if (!m || m === 'off') return { content: '', allowedMentions: { parse: [] } };
  if (m === 'everyone') return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
  return { content: `<@&${m}>`, allowedMentions: { roles: [m] } };
}

/**
 * Rollen des konfigurierten Guilds fürs Panel-Dropdown: die @everyone-Rolle und
 * verwaltete Integrations-Rollen (Bots etc.) raus, nach Position sortiert.
 * Leer, solange der Bot nicht verbunden ist.
 */
function getGuildRoles() {
  if (!DISCORD_GUILD_ID) return [];
  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return [];
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
}

/** Setzt die Live-Ansage-Mention (aus dem Panel) und speichert. Wirft bei Unfug. */
function setMention(value) {
  const mention = normalizeMention(value);
  settings = saveSettings(SETTINGS_FILE, { ...settings, mention });
  return settings;
}

// --- Rollenverteilung (Reaction-Roles) ---

/**
 * Text-/Ankündigungskanäle des konfigurierten Guilds fürs Panel-Dropdown.
 * Leer, solange der Bot nicht verbunden ist — dann fällt das Panel auf ein
 * ID-Eingabefeld zurück.
 */
function getTextChannels() {
  if (!DISCORD_GUILD_ID) return [];
  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return [];
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name }));
}

const getDistributors = () => settings.roleDistributors;

/** Verteilerliste speichern und settings neu übernehmen. */
function saveDistributors(list) {
  settings = saveSettings(SETTINGS_FILE, { ...settings, roleDistributors: list });
  return settings.roleDistributors;
}

/** Neuen Verteiler anlegen; gibt den erzeugten (inkl. frischer id) zurück. */
function createDistributor(data) {
  // id: undefined erzwingt eine neue id in normalizeDistributor.
  const dist = normalizeDistributor({ ...(data && typeof data === 'object' ? data : {}), id: undefined });
  saveDistributors([...settings.roleDistributors, dist]);
  return dist;
}

/**
 * Bestehenden Verteiler ändern. Nur mitgeschickte Felder werden gemerged; die
 * messageId bleibt erhalten, solange sie nicht ausdrücklich mitkommt (sie wird
 * vom Posten verwaltet, nicht im Editor).
 */
function updateDistributor(id, data) {
  const list = settings.roleDistributors;
  const idx = list.findIndex((d) => d.id === id);
  if (idx < 0) throw httpError(404, 'Verteiler nicht gefunden');
  const merged = { ...list[idx], ...(data && typeof data === 'object' ? data : {}), id };
  const next = [...list];
  next[idx] = normalizeDistributor(merged);
  saveDistributors(next);
  return next[idx];
}

function deleteDistributor(id) {
  const list = settings.roleDistributors;
  if (!list.some((d) => d.id === id)) throw httpError(404, 'Verteiler nicht gefunden');
  saveDistributors(list.filter((d) => d.id !== id));
}

/** Baut das Embed eines Verteilers inkl. automatischer Emoji→Rolle-Legende. */
function buildDistributorEmbed(dist) {
  const embed = new EmbedBuilder().setColor(ACCENT_COLOR)
    .setFooter({ text: 'Reagiere unten, um dir eine Rolle zu geben.' });
  if (dist.title) embed.setTitle(dist.title);
  if (dist.text) embed.setDescription(dist.text);
  if (dist.mappings.length) {
    const legend = dist.mappings.map((m) => `${m.emoji} → <@&${m.roleId}>`).join('\n');
    embed.addFields({ name: 'Reagiere für deine Rolle', value: legend.slice(0, 1024) });
  }
  return embed;
}

/**
 * Postet die Nachricht eines Verteilers und reagiert mit jedem Emoji. Speichert die
 * neue Message-ID (ersetzt eine alte). Gibt den aktualisierten Verteiler zurück plus
 * die Emojis, die nicht als Reaktion gesetzt werden konnten. Wirft mit httpStatus.
 */
async function postDistributor(id) {
  if (!client.isReady()) throw httpError(503, 'Bot ist noch nicht mit Discord verbunden');
  const dist = settings.roleDistributors.find((d) => d.id === id);
  if (!dist) throw httpError(404, 'Verteiler nicht gefunden');
  if (!dist.channelId) throw httpError(400, 'Kein Kanal konfiguriert');
  if (dist.mappings.length === 0) throw httpError(400, 'Keine Emoji→Rolle-Zuordnung konfiguriert');
  if (!dist.title && !dist.text) throw httpError(400, 'Titel und Text sind leer');

  const channel = await client.channels.fetch(dist.channelId).catch(() => null);
  if (!channel?.isTextBased()) throw httpError(400, `Kanal ${dist.channelId} ist kein Textkanal (oder Bot hat keinen Zugriff)`);

  // allowedMentions leer: die Rollen-Erwähnungen in der Legende sollen nicht pingen.
  const msg = await channel.send({ embeds: [buildDistributorEmbed(dist)], allowedMentions: { parse: [] } });

  // Mit jedem Emoji reagieren; ein einzelnes ungültiges soll die anderen nicht kippen.
  const failed = [];
  for (const m of dist.mappings) {
    try { await msg.react(m.emoji); } catch { failed.push(m.emoji); }
  }

  const updated = updateDistributor(id, { messageId: msg.id }); // speichert
  console.log(`[rollen] "${dist.name}" -> Nachricht ${msg.id} in #${channel.name ?? dist.channelId} ` +
    `(${dist.mappings.length - failed.length}/${dist.mappings.length} Reaktionen gesetzt)`);
  return { distributor: updated, failed };
}

/**
 * Gemeinsamer Handler für Hinzufügen/Entfernen einer Reaktion. Sucht den Verteiler
 * zur Nachricht und darin die Emoji→Rolle-Zuordnung, vergibt/entzieht die Rolle.
 * Liest die Verteilerliste bei jedem Event frisch, damit Panel-Änderungen ohne
 * Neustart greifen. Fängt alles ab: fehlende Rechte/unbekannte Member stoppen den
 * Bot nie.
 */
async function handleReaction(reaction, user, add) {
  try {
    // message.id und emoji sind auch bei Partials schon da — erst billig filtern,
    // bevor wir für fremde Reaktionen überhaupt etwas nachladen.
    const messageId = reaction.message.id;
    const dist = settings.roleDistributors.find((d) => d.messageId && d.messageId === messageId);
    if (!dist) return;
    const mapping = dist.mappings.find((m) => emojiMatches(reaction.emoji, m.emoji));
    if (!mapping) return;

    // Ab hier ist es unsere Nachricht: Partials auflösen, um an Guild/Member zu kommen.
    if (user.partial) { try { user = await user.fetch(); } catch { /* egal, Bot-Check unten */ } }
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const guild = reaction.message.guild;
    if (!guild) return;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      console.error(`[rollen] Member ${user.id} nicht gefunden — Rolle nicht ${add ? 'vergeben' : 'entfernt'}`);
      return;
    }

    if (add) {
      await member.roles.add(mapping.roleId);
      console.log(`[rollen] Rolle ${mapping.roleId} an ${member.user.tag} vergeben (${dist.name})`);
    } else {
      await member.roles.remove(mapping.roleId);
      console.log(`[rollen] Rolle ${mapping.roleId} von ${member.user.tag} entfernt (${dist.name})`);
    }
  } catch (err) {
    // Häufigster Fall: Bot-Rolle steht nicht über der Ziel-Rolle -> Missing Permissions.
    console.error(`[rollen] Konnte Rolle nicht ${add ? 'vergeben' : 'entfernen'}: ${err.message}`);
  }
}

// --- Slash-Befehle ---

// Code-Befehle haben Vorrang: eine gleichnamige JSON-Eintragung darf /live nicht verdecken.
const CODE_COMMANDS = liveEnabled ? [{ name: 'live', description: 'Läuft gerade ein Stream?' }] : [];
// Auch reserviert, wenn der Code-Befehl gerade deaktiviert ist — sonst legt man
// heute einen Textbefehl "live" an und wundert sich nach dem Twitch-Setup.
const RESERVED_NAMES = ['live'];

let textCommands = {};

/** Lädt commands.json neu und wirft Kollisionen mit reservierten Namen raus. */
function reloadTextCommands() {
  const { commands, errors } = loadCommands(COMMANDS_FILE);
  for (const msg of errors) console.error(`[commands] ${msg}`);
  // Gegen RESERVED_NAMES filtern, nicht nur gegen CODE_COMMANDS: "live" bleibt
  // auch dann gesperrt, wenn /live gerade mangels Twitch-Config deaktiviert ist.
  for (const name of RESERVED_NAMES) {
    if (commands[name]) {
      console.error(`[commands] "${name}" aus commands.json ignoriert — Name ist reserviert`);
      delete commands[name];
    }
  }
  textCommands = commands;
}
reloadTextCommands();

/** Baut die Discord-Definitionen aus dem aktuellen Stand. */
function buildCommandDefs() {
  return [
    ...Object.entries(textCommands).map(([name, { description, target }]) => ({
      name,
      description,
      ...(target === true && {
        options: [{
          name: TARGET_OPTION,
          description: 'Wen?',
          type: ApplicationCommandOptionType.User,
          required: true,
        }],
      }),
    })),
    ...CODE_COMMANDS,
  ];
}

// Ergebnis der letzten Registrierung, sichtbar im Admin-Panel.
let lastRegistration = { ok: false, at: null, names: [], error: 'noch nicht registriert' };

/** Registriert alle Befehle bei Discord (Guild-Scope: sofort sichtbar). */
async function registerCommands() {
  const defs = buildCommandDefs();

  if (!DISCORD_GUILD_ID) {
    lastRegistration = { ok: false, at: new Date().toISOString(), names: [], error: 'DISCORD_GUILD_ID fehlt' };
    console.log('[discord] DISCORD_GUILD_ID fehlt — keine Slash-Befehle registriert');
    return lastRegistration;
  }
  if (!client.isReady()) {
    lastRegistration = { ok: false, at: new Date().toISOString(), names: [], error: 'Bot nicht mit Discord verbunden' };
    return lastRegistration;
  }
  if (defs.length === 0) {
    lastRegistration = { ok: false, at: new Date().toISOString(), names: [], error: 'keine gültigen Befehle' };
    console.error('[discord] keine gültigen Befehle — nichts registriert');
    return lastRegistration;
  }

  try {
    await client.application.commands.set(defs, DISCORD_GUILD_ID);
    const names = defs.map((c) => '/' + c.name);
    lastRegistration = { ok: true, at: new Date().toISOString(), names, error: null };
    console.log(`[discord] ${defs.length} Befehle registriert: ${names.join(' ')}`);
  } catch (err) {
    lastRegistration = { ok: false, at: new Date().toISOString(), names: [], error: err.message };
    console.error('[discord] Befehle konnten nicht registriert werden:', err.message);
    console.error('[discord] Fehlt der OAuth2-Scope "applications.commands"? Bot neu einladen.');
  }
  return lastRegistration;
}

function randomReply(command) {
  const list = textCommands[command].replies;
  return list[Math.floor(Math.random() * list.length)];
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const textCommand = textCommands[interaction.commandName];
  if (textCommand) {
    try {
      let reply = randomReply(interaction.commandName);
      if (textCommand.target === true) {
        // Kann null sein, wenn die bei Discord registrierte Definition (noch)
        // keine User-Option hat — z.B. direkt nach dem Umstellen auf target,
        // solange die Registrierung noch nicht durch ist.
        const target = interaction.options.getUser(TARGET_OPTION);
        if (!target) {
          return interaction.reply({ content: 'Bitte gib jemanden an. (Befehl wird gerade aktualisiert — gleich nochmal versuchen.)', ephemeral: true });
        }
        reply = reply.replaceAll(TARGET_TOKEN, `<@${target.id}>`);
      }
      // Die Erwähnung soll pingen (darum kein allowedMentions-Filter),
      // aber @everyone/@here nie — auch nicht, wenn es in commands.json steht.
      return await interaction.reply({ content: reply, allowedMentions: { parse: ['users'] } });
    } catch (err) {
      console.error(`[command] /${interaction.commandName} Fehler:`, err.message);
      return;
    }
  }

  if (interaction.commandName === 'live') {
    if (!liveEnabled) {
      return interaction.reply('/live ist auf diesem Server nicht konfiguriert.');
    }
    // Discord verlangt Antwort binnen 3s, der Twitch-Aufruf kann länger dauern.
    await interaction.deferReply();
    try {
      const stream = await twitchClient.fetchStream();
      if (!stream) {
        const offline = (LIVE_OFFLINE_MESSAGE || '**{streamer}** ist gerade nicht live.')
          .replaceAll('{streamer}', TWITCH_LOGIN);
        return interaction.editReply(offline);
      }
      return interaction.editReply({
        embeds: [
          buildLiveEmbed({
            streamer: stream.user_name,
            title: stream.title,
            game: stream.game_name,
            thumbnailUrl: stream.thumbnail_url?.replace('{width}', '1280').replace('{height}', '720'),
            url: `https://twitch.tv/${stream.user_login}`,
          }, { color: ACCENT_COLOR, text: LIVE_EMBED_TEXT }),
        ],
      });
    } catch (err) {
      console.error('[live] Fehler:', err.message);
      return interaction.editReply(LIVE_ERROR_MESSAGE || 'Twitch ist gerade nicht erreichbar.');
    }
  }
});

// Reaction-Role: eine Reaktion vergibt die Rolle, ihr Entfernen nimmt sie wieder.
client.on('messageReactionAdd', (reaction, user) => handleReaction(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleReaction(reaction, user, false));

// --- HTTP-Endpoint für n8n ---

const app = express();
app.use(express.json());

// Healthcheck für docker-compose / n8n
app.get('/health', (_req, res) => {
  res.json({ ok: client.isReady(), bot: client.user?.tag ?? null });
});

// n8n POSTet hierhin, sobald der Stream online geht.
app.post('/notify', async (req, res) => {
  // Optionaler Schutz: nur aktiv, wenn NOTIFY_TOKEN gesetzt ist.
  if (NOTIFY_TOKEN) {
    const provided = req.get('X-Notify-Token') || (req.get('Authorization') || '').replace(/^Bearer /i, '');
    if (!safeEqual(provided, NOTIFY_TOKEN)) {
      return res.status(401).json({ error: 'ungültiges oder fehlendes Token' });
    }
  }

  // Ohne Ziel-Channel ist der Notify-Teil nicht konfiguriert (reiner Command-/
  // Reaction-Role-Bot). Klar melden statt an client.channels.fetch(undefined) crashen.
  if (!DISCORD_CHANNEL_ID) {
    return res.status(503).json({ error: 'DISCORD_CHANNEL_ID nicht gesetzt — /notify ist deaktiviert' });
  }

  const { streamer, title, game, thumbnailUrl, profileImageUrl, url } = req.body ?? {};

  if (!streamer || !url) {
    return res.status(400).json({ error: 'streamer und url sind Pflichtfelder' });
  }
  if (!client.isReady()) {
    return res.status(503).json({ error: 'Bot ist noch nicht mit Discord verbunden' });
  }

  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${DISCORD_CHANNEL_ID} ist kein Textkanal`);
    }

    const { content, allowedMentions } = buildMention();
    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(LIVE_BUTTON_LABEL || 'Zum Stream').setStyle(ButtonStyle.Link).setURL(url),
    );

    const msg = await channel.send({
      content,
      embeds: [buildLiveEmbed({ streamer, title, game, thumbnailUrl, profileImageUrl, url }, { color: ACCENT_COLOR, text: LIVE_EMBED_TEXT })],
      components: [button],
      allowedMentions,
    });

    console.log(`[notify] Nachricht ${msg.id} gesendet für ${streamer}`);
    res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error('[notify] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Admin-Panel ---

// Schreibvorgänge nacheinander abarbeiten, damit sich zwei gleichzeitige
// Speichern-Klicks nicht gegenseitig die Datei zerschießen.
let writeLock = Promise.resolve();

/**
 * Wendet eine Mutation atomar an: der Mutator bekommt den AKTUELLEN Stand
 * (erst innerhalb der Sperre gelesen, nicht vorher im Handler), gibt den neuen
 * zurück oder wirft. So kann eine zweite Änderung, die während der Discord-
 * Registrierung einer ersten hereinkommt, nichts mehr überschreiben.
 * Der Mutator darf einen Fehler mit .httpStatus werfen (404/409/400 …).
 */
function mutateCommands(mutator) {
  const run = writeLock.then(async () => {
    const next = mutator(textCommands);
    saveCommands(COMMANDS_FILE, next);
    reloadTextCommands();
    const registration = await registerCommands();
    return { registration };
  });
  // Fehler hier schlucken, damit die Kette weiterläuft; der Aufrufer bekommt
  // den echten Fehler über das zurückgegebene Promise.
  writeLock = run.catch(() => {});
  return run;
}

if (ADMIN_PASSWORD) {
  const adminApp = createAdminServer({
    password: ADMIN_PASSWORD,
    getBrand,
    getStatus: () => ({
      bot: client.user?.tag ?? null,
      ready: client.isReady(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      guildConfigured: Boolean(DISCORD_GUILD_ID),
      liveEnabled,
      counts: { text: Object.keys(textCommands).length, code: CODE_COMMANDS.length },
      lastRegistration,
      commandsFile: String(COMMANDS_FILE),
    }),
    getCommands: () => textCommands,
    codeCommands: CODE_COMMANDS,
    reservedNames: RESERVED_NAMES,
    trustProxy: ADMIN_TRUST_PROXY,
    mutateCommands,
    registerNow: registerCommands,
    getSettings: () => settings,
    getRoles: getGuildRoles,
    setMention,
    getChannels: getTextChannels,
    getDistributors,
    createDistributor,
    updateDistributor,
    deleteDistributor,
    postDistributor,
  });
  adminApp.listen(Number(ADMIN_PORT), () => {
    console.log(`[admin] Panel lauscht auf Port ${ADMIN_PORT}`);
  });
} else {
  console.log('[admin] deaktiviert — ADMIN_PASSWORD fehlt');
}

client.once('clientReady', async () => {
  console.log(`[discord] Online als ${client.user.tag}`);
  await registerCommands();
  if (!liveEnabled) console.log('[discord] /live ausgelassen — TWITCH_CLIENT_ID/SECRET/LOGIN unvollständig');
});

client.on('error', (err) => console.error('[discord] Fehler:', err.message));

// HTTP zuerst starten: n8n bekommt so ein sauberes 503 statt Connection-Refused,
// falls Discord gerade noch verbindet oder kurz wegbricht.
const server = app.listen(Number(HTTP_PORT), () => {
  console.log(`[http] Endpoint lauscht auf Port ${HTTP_PORT}`);
});

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('[fatal] Discord-Login fehlgeschlagen:', err.message);
  process.exit(1);
});

// Sauberes Herunterfahren, damit der Bot nicht minutenlang als "online" hängen bleibt.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[exit] ${signal} empfangen, fahre herunter`);
    server.close();
    client.destroy();
    process.exit(0);
  });
}
