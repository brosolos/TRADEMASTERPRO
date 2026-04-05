// ════════════════════════════════════════════════════════════════
//  🏴‍☠️  SAILOR PIECE — Trade Marketplace Bot  v2.0
//  Hosted on Railway — env vars set via Railway dashboard
//
//  npm install discord.js @discordjs/rest dotenv node-cron
// ════════════════════════════════════════════════════════════════

// Railway provides env vars automatically — dotenv is a fallback
// for local dev only. On Railway, never use a .env file.
require("dotenv").config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, ChannelType, PermissionFlagsBits, Collection,
  ActivityType,
} = require("discord.js");
const cron = require("node-cron");

// ─── Environment Variables (set these in Railway dashboard) ────
//
//  REQUIRED:
//    BOT_TOKEN            — Discord bot token
//    CLIENT_ID            — Application/client ID
//    OWNER_ID             — Your personal Discord user ID (owner-only cmds)
//
//  OPTIONAL:
//    TRADE_CATEGORY_ID    — Category ID for ticket channels
//    MOD_ROLE_ID          — Role ID for moderators
//    LOG_CHANNEL_ID       — Channel ID for audit logs
//    ANNOUNCE_CHANNEL_ID  — Channel ID to post new trade announcements
//    COOLDOWN_SECONDS     — Trade post cooldown (default 60)
//    MAX_ACTIVE_TRADES    — Max trades per user (default 5)
//
const TOKEN               = process.env.BOT_TOKEN;
const CLIENT_ID           = process.env.CLIENT_ID;
const OWNER_ID            = process.env.OWNER_ID;
const TRADE_CATEGORY_ID   = process.env.TRADE_CATEGORY_ID;
const MOD_ROLE_ID         = process.env.MOD_ROLE_ID;
const LOG_CHANNEL_ID      = process.env.LOG_CHANNEL_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
let   COOLDOWN_SECONDS    = parseInt(process.env.COOLDOWN_SECONDS ?? "60");
const MAX_ACTIVE_TRADES   = parseInt(process.env.MAX_ACTIVE_TRADES ?? "5");

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing required env vars: BOT_TOKEN, CLIENT_ID, OWNER_ID");
  process.exit(1);
}

// ─── In-Memory State ────────────────────────────────────────────
const activeTrades     = new Collection(); // postId → tradeData
const userCooldowns    = new Collection(); // userId → timestamp
const blacklistedUsers = new Set();        // userId
const warnedUsers      = new Map();        // userId → warnCount
const botStats = {
  tradesPosted:    0,
  tradesCompleted: 0,
  ticketsOpened:   0,
  reportsHandled:  0,
  startedAt:       Date.now(),
};

let tradeCounter = 325700;

// ─── Slash commands ──────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("trade")
    .setDescription("📦 Post a trade listing on the Sailor Piece marketplace"),

  new SlashCommandBuilder()
    .setName("mytrades")
    .setDescription("📋 View all your active trade listings"),

  new SlashCommandBuilder()
    .setName("canceltrade")
    .setDescription("❌ Cancel one of your active trade listings")
    .addStringOption(o => o.setName("postid").setDescription("Post ID to cancel").setRequired(true)),

  new SlashCommandBuilder()
    .setName("tradeinfo")
    .setDescription("🔍 Look up a trade listing by Post ID")
    .addStringOption(o => o.setName("postid").setDescription("Post ID to look up").setRequired(true)),

  new SlashCommandBuilder()
    .setName("marketplace")
    .setDescription("🏪 Browse all open trade listings"),

  new SlashCommandBuilder()
    .setName("tradestats")
    .setDescription("📊 View marketplace statistics"),

  new SlashCommandBuilder()
    .setName("checkscammer")
    .setDescription("🔎 Check if a user is on the scammer blacklist")
    .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("owner")
    .setDescription("👑 Owner-only admin commands")
    .addSubcommand(s => s
      .setName("blacklist")
      .setDescription("🚫 Add a user to the scammer blacklist")
      .addUserOption(o => o.setName("user").setDescription("User to blacklist").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("unblacklist")
      .setDescription("✅ Remove a user from the blacklist")
      .addUserOption(o => o.setName("user").setDescription("User to unblacklist").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("warn")
      .setDescription("⚠️ Warn a user (auto-blacklists at 3 warnings)")
      .addUserOption(o => o.setName("user").setDescription("User to warn").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("deletetrade")
      .setDescription("🗑️ Force-delete any trade listing")
      .addStringOption(o => o.setName("postid").setDescription("Post ID").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false))
    )
    .addSubcommand(s => s
      .setName("announce")
      .setDescription("📢 Send a marketplace announcement")
      .addStringOption(o => o.setName("message").setDescription("Announcement text").setRequired(true))
    )
    .addSubcommand(s => s
      .setName("stats")
      .setDescription("📊 View detailed bot statistics (owner only)")
    )
    .addSubcommand(s => s
      .setName("clearall")
      .setDescription("🧹 Clear ALL trade listings")
    )
    .addSubcommand(s => s
      .setName("setcooldown")
      .setDescription("⏱️ Update the trade post cooldown for this session")
      .addIntegerOption(o => o.setName("seconds").setDescription("Cooldown in seconds").setRequired(true).setMinValue(0).setMaxValue(3600))
    )
    .addSubcommand(s => s
      .setName("botstatus")
      .setDescription("🤖 Change the bot's activity status")
      .addStringOption(o => o.setName("text").setDescription("Status text").setRequired(true))
    ),

].map(c => c.toJSON());

// ─── Register commands ───────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("🔄 Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered!");
  } catch (e) {
    console.error("❌ Command registration failed:", e);
  }
}

// ─── Client ─────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function isOwner(userId)  { return userId === OWNER_ID; }
function isMod(member)    { return MOD_ROLE_ID && member?.roles?.cache?.has(MOD_ROLE_ID); }
function isBlacklisted(uid) { return blacklistedUsers.has(uid); }

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

async function logAction(guild, title, description, color = 0x3498db) {
  if (!LOG_CHANNEL_ID) return;
  const ch = guild?.channels?.cache?.get(LOG_CHANNEL_ID);
  if (!ch) return;
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp()
        .setFooter({ text: "Sailor Piece Audit Log" }),
    ],
  }).catch(() => {});
}

function buildTradeEmbed(trade, guild) {
  const colors = { open: 0x2ecc71, pending: 0xf39c12, closed: 0xe74c3c, completed: 0x3498db };
  const statusEmoji = { open: "🟢", pending: "🟡", closed: "🔴", completed: "✅" };

  const embed = new EmbedBuilder()
    .setColor(colors[trade.status] ?? 0x2ecc71)
    .setAuthor({ name: "⚓ Sailor Piece — Trade Marketplace", iconURL: guild?.iconURL() ?? undefined })
    .setTitle(`🏴‍☠️  Post ID: \`${trade.postId}\``)
    .addFields(
      { name: "👤 Trader",      value: `<@${trade.userId}>`, inline: true },
      { name: "📅 Posted",      value: `<t:${Math.floor(trade.createdAt / 1000)}:R>`, inline: true },
      { name: "📊 Status",      value: `${statusEmoji[trade.status]} ${trade.status.toUpperCase()}`, inline: true },
      { name: "🎁 Offering",    value: trade.offering, inline: false },
      { name: "🔍 Looking For", value: trade.lookingFor, inline: false },
    );

  if (trade.beli)   embed.addFields({ name: "💰 Beli",    value: `${Number(trade.beli).toLocaleString()} 🪙`, inline: true });
  if (trade.server) embed.addFields({ name: "🏝️ Server", value: trade.server, inline: true });
  if (trade.notes)  embed.addFields({ name: "📝 Notes",   value: trade.notes, inline: false });
  if (trade.views != null) embed.addFields({ name: "👁️ Views", value: `${trade.views}`, inline: true });

  embed.setFooter({ text: `Post ID: ${trade.postId}  •  Click a button to interact` }).setTimestamp();
  return embed;
}

function buildTradeButtons(trade) {
  const open = trade.status === "open";

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`chat_${trade.postId}`)
      .setLabel("Chat with User").setEmoji("📝").setStyle(ButtonStyle.Success).setDisabled(!open),
    new ButtonBuilder().setCustomId(`delete_${trade.postId}`)
      .setLabel("Delete Post").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`report_${trade.postId}`)
      .setLabel("Report Post").setEmoji("🚩").setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`offer_${trade.postId}`)
      .setLabel("Counter Offer").setEmoji("💬").setStyle(ButtonStyle.Primary).setDisabled(!open),
    new ButtonBuilder().setCustomId(`bookmark_${trade.postId}`)
      .setLabel("Bookmark").setEmoji("🔖").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`share_${trade.postId}`)
      .setLabel("Share").setEmoji("📤").setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

function buildTradeModal() {
  return new ModalBuilder()
    .setCustomId("trade_modal")
    .setTitle("🏴‍☠️ Post a Trade — Sailor Piece")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("offering")
          .setLabel("What are you OFFERING?")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
          .setPlaceholder("e.g. Ope Ope no Mi (awakened) + 50M Beli")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("looking_for")
          .setLabel("What are you LOOKING FOR?")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
          .setPlaceholder("e.g. Gura Gura no Mi, or any Mythical Zoan")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("beli")
          .setLabel("Beli amount (leave blank if trade-only)")
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)
          .setPlaceholder("e.g. 100000000")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("server")
          .setLabel("Preferred Server (e.g. Sea 1, NA, Any)")
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50)
          .setPlaceholder("Any")
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("notes")
          .setLabel("Additional Notes (optional)")
          .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400)
          .setPlaceholder("Timezone, level req, method of trade, etc.")
      ),
    );
}

async function createTradeTicket(guild, initiator, tradeOwner, trade) {
  const name = `trade-${trade.postId}-${initiator.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15)}`;
  const existing = guild.channels.cache.find(c => c.name === name);
  if (existing) return { channel: existing, alreadyExisted: true };

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: initiator.id,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: tradeOwner.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ];
  if (MOD_ROLE_ID) overwrites.push({ id: MOD_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: TRADE_CATEGORY_ID ?? null,
    permissionOverwrites: overwrites,
    topic: `🤝 Trade Ticket | Post ID: ${trade.postId} | ${initiator.tag} ↔ ${tradeOwner.tag}`,
  });

  return { channel, alreadyExisted: false };
}

async function postTicketIntro(channel, initiator, tradeOwner, trade) {
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle("🤝 Trade Ticket Opened!")
    .setDescription(
      `Welcome, <@${initiator.id}> and <@${tradeOwner.id}>!\n\n` +
      `This is your **private trade channel** — only you two and moderators can see it.\n` +
      `Discuss your trade, agree on terms, then click **Mark Complete** when done.\n\n` +
      `⚠️ **Never share personal info. All trades are at your own risk.**`
    )
    .addFields(
      { name: "📋 Post ID",     value: `\`${trade.postId}\``, inline: true },
      { name: "🎁 Offering",    value: trade.offering,        inline: false },
      { name: "🔍 Looking For", value: trade.lookingFor,      inline: false },
    )
    .setFooter({ text: "Sailor Piece Trade Marketplace • Be honest and fair, pirate!" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`close_ticket_${channel.id}`)
      .setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`trade_complete_${trade.postId}`)
      .setLabel("Mark Trade Complete").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`escalate_${channel.id}`)
      .setLabel("Call a Mod").setEmoji("🛡️").setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ content: `<@${initiator.id}> <@${tradeOwner.id}>`, embeds: [embed], components: [row] });
}

async function announceNewTrade(guild, trade) {
  if (!ANNOUNCE_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
  if (!ch) return;
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle("📦 New Trade Listed!")
        .addFields(
          { name: "Post ID",     value: `\`${trade.postId}\``,         inline: true },
          { name: "Trader",      value: `<@${trade.userId}>`,           inline: true },
          { name: "🎁 Offering", value: trade.offering.slice(0, 200),   inline: false },
          { name: "🔍 Looking",  value: trade.lookingFor.slice(0, 200), inline: false },
        )
        .setFooter({ text: "Use /tradeinfo <postid> to see full details" })
        .setTimestamp(),
    ],
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
//  READY
// ═══════════════════════════════════════════════════════════════

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity("🏴‍☠️ Sailor Piece Marketplace", { type: ActivityType.Watching });
  await registerCommands();

  // Rotate status every 5 minutes
  const statuses = [
    () => ({ name: "🏴‍☠️ Sailor Piece Marketplace", type: ActivityType.Watching }),
    () => ({ name: `📦 ${botStats.tradesPosted} trades posted`, type: ActivityType.Watching }),
    () => ({ name: "⚓ Use /trade to list!", type: ActivityType.Listening }),
    () => ({ name: `🏝️ ${activeTrades.size} active listings`, type: ActivityType.Watching }),
  ];
  let si = 0;
  setInterval(() => { const s = statuses[si++ % statuses.length](); client.user.setActivity(s.name, { type: s.type }); }, 5 * 60 * 1000);

  // Auto-expire trades older than 72 hours
  cron.schedule("0 * * * *", () => {
    const now = Date.now();
    for (const [id, trade] of activeTrades) {
      if (trade.status === "open" && now - trade.createdAt > 72 * 60 * 60 * 1000) {
        trade.status = "closed";
        activeTrades.delete(id);
        console.log(`⏰ Auto-expired trade ${id}`);
      }
    }
  });

  console.log(`📊 Ready. Cooldown: ${COOLDOWN_SECONDS}s | Max trades/user: ${MAX_ACTIVE_TRADES}`);
});

// ═══════════════════════════════════════════════════════════════
//  INTERACTION HANDLER
// ═══════════════════════════════════════════════════════════════

client.on("interactionCreate", async (interaction) => {
  try { await handleInteraction(interaction); }
  catch (err) {
    console.error("❌ Interaction error:", err);
    const reply = { content: "❌ Something went wrong. Try again!", ephemeral: true };
    if (interaction.deferred) await interaction.editReply(reply).catch(() => {});
    else if (!interaction.replied) await interaction.reply(reply).catch(() => {});
  }
});

async function handleInteraction(interaction) {
  const { user, guild } = interaction;

  // ══════════════════ SLASH COMMANDS ══════════════════════════
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;

    // /trade
    if (cmd === "trade") {
      if (isBlacklisted(user.id))
        return interaction.reply({ content: "🚫 You are blacklisted from the Sailor Piece marketplace.", ephemeral: true });

      const last = userCooldowns.get(user.id);
      if (last && Date.now() - last < COOLDOWN_SECONDS * 1000) {
        const remaining = Math.ceil((COOLDOWN_SECONDS * 1000 - (Date.now() - last)) / 1000);
        return interaction.reply({ content: `⏳ **Slow down, pirate!** Wait **${remaining}s** before posting again.`, ephemeral: true });
      }

      const myOpen = [...activeTrades.values()].filter(t => t.userId === user.id && t.status === "open").length;
      if (myOpen >= MAX_ACTIVE_TRADES)
        return interaction.reply({ content: `📛 You already have **${myOpen}** active listings (max ${MAX_ACTIVE_TRADES}). Use \`/canceltrade\` first.`, ephemeral: true });

      userCooldowns.set(user.id, Date.now());
      await interaction.showModal(buildTradeModal());
    }

    // /mytrades
    else if (cmd === "mytrades") {
      const mine = [...activeTrades.values()].filter(t => t.userId === user.id);
      if (!mine.length) return interaction.reply({ content: "📭 You have no active listings. Use `/trade` to post one!", ephemeral: true });

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📋 Your Listings (${mine.length}/${MAX_ACTIVE_TRADES})`)
        .setDescription(mine.map(t =>
          `**\`${t.postId}\`** • ${t.status.toUpperCase()}\n🎁 ${t.offering.slice(0, 80)}\n🔍 ${t.lookingFor.slice(0, 80)}`
        ).join("\n\n"))
        .setFooter({ text: "Use /canceltrade <postid> to remove a listing" });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /canceltrade
    else if (cmd === "canceltrade") {
      const postId = interaction.options.getString("postid");
      const trade  = activeTrades.get(postId);
      if (!trade) return interaction.reply({ content: `❌ No trade found with Post ID \`${postId}\`.`, ephemeral: true });
      if (trade.userId !== user.id && !isOwner(user.id) && !isMod(interaction.member))
        return interaction.reply({ content: "⛔ You can only cancel your own listings.", ephemeral: true });

      trade.status = "closed";
      activeTrades.delete(postId);

      try {
        const ch  = guild.channels.cache.get(trade.channelId);
        const msg = await ch?.messages.fetch(trade.messageId);
        if (msg) await msg.edit({ embeds: [buildTradeEmbed(trade, guild)], components: [] });
      } catch {}

      await interaction.reply({ content: `✅ Trade \`${postId}\` cancelled.`, ephemeral: true });
      await logAction(guild, "🗑️ Trade Cancelled", `<@${user.id}> cancelled trade \`${postId}\``, 0xe74c3c);
    }

    // /tradeinfo
    else if (cmd === "tradeinfo") {
      const postId = interaction.options.getString("postid");
      const trade  = activeTrades.get(postId);
      if (!trade) return interaction.reply({ content: `❌ No trade found with Post ID \`${postId}\`.`, ephemeral: true });
      trade.views = (trade.views ?? 0) + 1;
      await interaction.reply({ embeds: [buildTradeEmbed(trade, guild)], ephemeral: true });
    }

    // /marketplace
    else if (cmd === "marketplace") {
      const open = [...activeTrades.values()].filter(t => t.status === "open");
      if (!open.length) return interaction.reply({ content: "🏪 The marketplace is empty! Use `/trade` to list something.", ephemeral: true });

      const pages = [];
      for (let i = 0; i < open.length; i += 8) pages.push(open.slice(i, i + 8));

      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle(`🏪 Sailor Piece Marketplace — ${open.length} Open Listing${open.length !== 1 ? "s" : ""}`)
        .setDescription(pages[0].map(t =>
          `**\`${t.postId}\`** <@${t.userId}>\n🎁 ${t.offering.slice(0, 70)}...\n🔍 ${t.lookingFor.slice(0, 70)}...`
        ).join("\n\n"))
        .setFooter({ text: `Page 1/${pages.length} • /tradeinfo <postid> for full details` })
        .setTimestamp();

      const rows = [];
      if (pages.length > 1) rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`market_page_1`).setLabel("Next Page →").setStyle(ButtonStyle.Secondary)
        )
      );

      await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
    }

    // /tradestats
    else if (cmd === "tradestats") {
      const open    = [...activeTrades.values()].filter(t => t.status === "open").length;
      const pending = [...activeTrades.values()].filter(t => t.status === "pending").length;

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("📊 Sailor Piece — Marketplace Stats")
        .addFields(
          { name: "📦 Trades Posted",     value: `${botStats.tradesPosted}`,    inline: true },
          { name: "✅ Trades Completed",  value: `${botStats.tradesCompleted}`, inline: true },
          { name: "💬 Tickets Opened",    value: `${botStats.ticketsOpened}`,   inline: true },
          { name: "🟢 Open Listings",     value: `${open}`,                     inline: true },
          { name: "🟡 In Ticket",         value: `${pending}`,                  inline: true },
          { name: "🚫 Blacklisted",       value: `${blacklistedUsers.size}`,    inline: true },
          { name: "🚩 Reports Handled",   value: `${botStats.reportsHandled}`,  inline: true },
          { name: "⏱️ Uptime",           value: formatUptime(Date.now() - botStats.startedAt), inline: true },
        )
        .setFooter({ text: "Sailor Piece Trade Marketplace" })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    // /checkscammer
    else if (cmd === "checkscammer") {
      const target = interaction.options.getUser("user");
      const bl     = blacklistedUsers.has(target.id);
      const warns  = warnedUsers.get(target.id) ?? 0;

      const embed = new EmbedBuilder()
        .setColor(bl ? 0xe74c3c : 0x2ecc71)
        .setTitle(bl ? "🚫 User is BLACKLISTED" : "✅ User is Clear")
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: "User",     value: `${target.tag} (\`${target.id}\`)`, inline: false },
          { name: "Status",   value: bl ? "🔴 **BLACKLISTED — Do not trade!**" : "🟢 Not blacklisted", inline: true },
          { name: "Warnings", value: `${warns}`, inline: true },
        )
        .setFooter({ text: "Always trade carefully. No bot can guarantee safety." })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    // /owner
    else if (cmd === "owner") {
      if (!isOwner(user.id))
        return interaction.reply({ content: "👑 These commands are reserved for the bot owner.", ephemeral: true });

      const sub = interaction.options.getSubcommand();

      if (sub === "blacklist") {
        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        blacklistedUsers.add(target.id);

        let removed = 0;
        for (const [id, trade] of activeTrades) {
          if (trade.userId === target.id) { activeTrades.delete(id); removed++; }
        }

        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle("🚫 User Blacklisted")
            .addFields(
              { name: "User",           value: `${target.tag} (\`${target.id}\`)`, inline: false },
              { name: "Reason",         value: reason, inline: false },
              { name: "Trades Removed", value: `${removed}`, inline: true },
              { name: "By",             value: `<@${user.id}>`, inline: true },
            ).setTimestamp()],
        });

        target.send({ embeds: [new EmbedBuilder().setColor(0xe74c3c)
          .setTitle("🚫 You have been blacklisted from Sailor Piece Marketplace")
          .setDescription(`**Reason:** ${reason}\n\nIf you believe this is an error, contact server staff.`)
        ]}).catch(() => {});

        await logAction(guild, "🚫 User Blacklisted",
          `<@${user.id}> blacklisted <@${target.id}>\n**Reason:** ${reason}\n**Trades removed:** ${removed}`, 0xe74c3c);
      }

      else if (sub === "unblacklist") {
        const target = interaction.options.getUser("user");
        if (!blacklistedUsers.has(target.id))
          return interaction.reply({ content: `ℹ️ ${target.tag} is not blacklisted.`, ephemeral: true });
        blacklistedUsers.delete(target.id);
        await interaction.reply({ content: `✅ **${target.tag}** removed from blacklist.` });
        await logAction(guild, "✅ User Unblacklisted", `<@${user.id}> unblacklisted <@${target.id}>`, 0x2ecc71);
      }

      else if (sub === "warn") {
        const target = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        const count  = (warnedUsers.get(target.id) ?? 0) + 1;
        warnedUsers.set(target.id, count);

        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0xf39c12).setTitle("⚠️ User Warned")
            .addFields(
              { name: "User",        value: `${target.tag}`, inline: true },
              { name: "Total Warns", value: `${count}`,      inline: true },
              { name: "Reason",      value: reason,          inline: false },
            ).setTimestamp()],
        });

        target.send({ embeds: [new EmbedBuilder().setColor(0xf39c12)
          .setTitle(`⚠️ Warning #${count} — Sailor Piece Marketplace`)
          .setDescription(`**Reason:** ${reason}\n\nFurther violations may result in a blacklist.`)
        ]}).catch(() => {});

        if (count >= 3) {
          blacklistedUsers.add(target.id);
          await interaction.followUp({ content: `⚠️ **${target.tag}** reached 3 warnings and has been auto-blacklisted.` });
          await logAction(guild, "🚫 Auto-Blacklisted (3 Warns)", `<@${target.id}> auto-blacklisted after 3 warnings.`, 0xe74c3c);
        }

        await logAction(guild, "⚠️ User Warned",
          `<@${user.id}> warned <@${target.id}> (warn #${count})\n**Reason:** ${reason}`, 0xf39c12);
      }

      else if (sub === "deletetrade") {
        const postId = interaction.options.getString("postid");
        const reason = interaction.options.getString("reason") ?? "No reason given";
        const trade  = activeTrades.get(postId);
        if (!trade) return interaction.reply({ content: `❌ Trade \`${postId}\` not found.`, ephemeral: true });

        trade.status = "closed";
        activeTrades.delete(postId);

        try {
          const ch  = guild.channels.cache.get(trade.channelId);
          const msg = await ch?.messages.fetch(trade.messageId);
          if (msg) await msg.edit({ embeds: [buildTradeEmbed(trade, guild)], components: [] });
        } catch {}

        await interaction.reply({ content: `🗑️ Force-deleted trade \`${postId}\`. Reason: ${reason}` });
        await logAction(guild, "🗑️ Trade Force-Deleted",
          `<@${user.id}> deleted trade \`${postId}\`\n**Reason:** ${reason}`, 0xe74c3c);

        client.users.fetch(trade.userId).then(o =>
          o.send({ content: `⚠️ Your trade \`${postId}\` was removed by a marketplace admin.\n**Reason:** ${reason}` }).catch(() => {})
        ).catch(() => {});
      }

      else if (sub === "announce") {
        const msg = interaction.options.getString("message");
        const ch  = ANNOUNCE_CHANNEL_ID ? guild.channels.cache.get(ANNOUNCE_CHANNEL_ID) : null;
        if (!ch) return interaction.reply({ content: "❌ Set ANNOUNCE_CHANNEL_ID in Railway env vars first.", ephemeral: true });

        await ch.send({
          content: "@everyone",
          embeds: [new EmbedBuilder().setColor(0xf39c12)
            .setTitle("📢 Marketplace Announcement")
            .setDescription(msg)
            .setFooter({ text: `By ${user.tag}` })
            .setTimestamp()],
        });
        await interaction.reply({ content: `✅ Announced to <#${ch.id}>.`, ephemeral: true });
        await logAction(guild, "📢 Announcement", `<@${user.id}>: ${msg}`, 0xf39c12);
      }

      else if (sub === "stats") {
        const mem = process.memoryUsage();
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle("🤖 Owner Bot Stats")
            .addFields(
              { name: "📦 Trades Posted",  value: `${botStats.tradesPosted}`,    inline: true },
              { name: "✅ Completed",       value: `${botStats.tradesCompleted}`, inline: true },
              { name: "💬 Tickets",         value: `${botStats.ticketsOpened}`,   inline: true },
              { name: "🗂️ Active",         value: `${activeTrades.size}`,        inline: true },
              { name: "🚫 Blacklisted",     value: `${blacklistedUsers.size}`,    inline: true },
              { name: "⚠️ Warned",         value: `${warnedUsers.size}`,         inline: true },
              { name: "⏱️ Uptime",         value: formatUptime(Date.now() - botStats.startedAt), inline: true },
              { name: "🏠 Guilds",          value: `${client.guilds.cache.size}`, inline: true },
              { name: "🧠 RAM",             value: `${(mem.heapUsed/1024/1024).toFixed(1)} MB`, inline: true },
              { name: "⏱ Cooldown",        value: `${COOLDOWN_SECONDS}s`,        inline: true },
              { name: "📊 Max/User",        value: `${MAX_ACTIVE_TRADES}`,        inline: true },
            ).setTimestamp()],
          ephemeral: true,
        });
      }

      else if (sub === "clearall") {
        const count = activeTrades.size;
        activeTrades.clear();
        await interaction.reply({ content: `🧹 Cleared **${count}** trade listing(s).` });
        await logAction(guild, "🧹 All Trades Cleared", `<@${user.id}> wiped all ${count} listings.`, 0xe74c3c);
      }

      else if (sub === "setcooldown") {
        COOLDOWN_SECONDS = interaction.options.getInteger("seconds");
        await interaction.reply({ content: `✅ Cooldown set to **${COOLDOWN_SECONDS}s** for this session.\n*(To persist: update \`COOLDOWN_SECONDS\` in Railway → Variables → Redeploy.)*` });
      }

      else if (sub === "botstatus") {
        const text = interaction.options.getString("text");
        client.user.setActivity(text, { type: ActivityType.Watching });
        await interaction.reply({ content: `✅ Status updated: **${text}**`, ephemeral: true });
      }
    }
  }

  // ══════════════════ MODALS ═══════════════════════════════════
  else if (interaction.isModalSubmit()) {

    if (interaction.customId === "trade_modal") {
      const offering   = interaction.fields.getTextInputValue("offering");
      const lookingFor = interaction.fields.getTextInputValue("looking_for");
      const beli       = interaction.fields.getTextInputValue("beli");
      const server     = interaction.fields.getTextInputValue("server");
      const notes      = interaction.fields.getTextInputValue("notes");

      const postId = `${++tradeCounter}`;
      const trade  = {
        postId, userId: user.id,
        offering, lookingFor,
        beli: beli || null, server: server || "Any", notes: notes || null,
        status: "open", createdAt: Date.now(),
        channelId: null, messageId: null, views: 0,
      };

      activeTrades.set(postId, trade);
      botStats.tradesPosted++;

      const reply = await interaction.reply({
        embeds: [buildTradeEmbed(trade, guild)],
        components: buildTradeButtons(trade),
        fetchReply: true,
      });

      trade.channelId = reply.channelId;
      trade.messageId = reply.id;

      await announceNewTrade(guild, trade);
      await logAction(guild, "📦 New Trade", `<@${user.id}> posted \`${postId}\`\n🎁 ${offering}\n🔍 ${lookingFor}`, 0x2ecc71);
    }

    else if (interaction.customId.startsWith("report_modal_")) {
      const postId = interaction.customId.replace("report_modal_", "");
      const reason = interaction.fields.getTextInputValue("reason");
      botStats.reportsHandled++;
      await interaction.reply({ content: `✅ Report submitted for \`${postId}\`. Mods have been notified.`, ephemeral: true });
      await logAction(guild, "🚩 Trade Reported", `<@${user.id}> reported \`${postId}\`\n**Reason:** ${reason}`, 0xe74c3c);
    }

    else if (interaction.customId.startsWith("counter_modal_")) {
      const postId  = interaction.customId.replace("counter_modal_", "");
      const trade   = activeTrades.get(postId);
      const counter = interaction.fields.getTextInputValue("counter");
      await interaction.reply({ content: "✅ Counter offer sent!", ephemeral: true });

      if (trade) {
        const owner = await client.users.fetch(trade.userId).catch(() => null);
        owner?.send({ embeds: [new EmbedBuilder().setColor(0x3498db)
          .setTitle("💬 New Counter Offer on Your Trade!")
          .addFields(
            { name: "Post ID",    value: `\`${postId}\``,   inline: true },
            { name: "From",       value: `<@${user.id}>`,   inline: true },
            { name: "Their Offer",value: counter,           inline: false },
          )
          .setFooter({ text: "Open a trade ticket to respond!" })
          .setTimestamp()
        ]}).catch(() => {});
      }

      await logAction(guild, "💬 Counter Offer", `<@${user.id}> counter-offered on \`${postId}\`:\n${counter}`, 0x3498db);
    }
  }

  // ══════════════════ BUTTONS ══════════════════════════════════
  else if (interaction.isButton()) {
    const parts  = interaction.customId.split("_");
    const action = parts[0];
    const postId = parts.slice(1).join("_");

    if (action === "chat") {
      const trade = activeTrades.get(postId);
      if (!trade)                   return interaction.reply({ content: "❌ Trade not found.", ephemeral: true });
      if (trade.userId === user.id) return interaction.reply({ content: "⛔ You can't open a ticket with yourself!", ephemeral: true });
      if (trade.status !== "open")  return interaction.reply({ content: "❌ This trade is no longer accepting inquiries.", ephemeral: true });
      if (isBlacklisted(user.id))   return interaction.reply({ content: "🚫 You are blacklisted from this marketplace.", ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      const tradeOwner = await guild.members.fetch(trade.userId).catch(() => null);
      if (!tradeOwner) return interaction.editReply({ content: "❌ Trade owner not found — they may have left." });

      const { channel, alreadyExisted } = await createTradeTicket(guild, user, tradeOwner.user, trade);
      if (alreadyExisted) return interaction.editReply({ content: `📬 You already have a ticket open: <#${channel.id}>` });

      await postTicketIntro(channel, user, tradeOwner.user, trade);
      trade.status = "pending";
      botStats.ticketsOpened++;

      try {
        const ch  = guild.channels.cache.get(trade.channelId);
        const msg = await ch?.messages.fetch(trade.messageId);
        if (msg) await msg.edit({ embeds: [buildTradeEmbed(trade, guild)], components: buildTradeButtons(trade) });
      } catch {}

      await interaction.editReply({ content: `✅ Ticket opened! Go to <#${channel.id}>` });
      await logAction(guild, "💬 Ticket Opened", `<@${user.id}> opened ticket for \`${postId}\` with <@${trade.userId}>`, 0xf39c12);
    }

    else if (action === "delete") {
      const trade = activeTrades.get(postId);
      if (!trade) return interaction.reply({ content: "❌ Trade not found.", ephemeral: true });
      if (trade.userId !== user.id && !isOwner(user.id) && !isMod(interaction.member))
        return interaction.reply({ content: "⛔ Only the trade owner, mods, or owner can delete this.", ephemeral: true });

      trade.status = "closed";
      activeTrades.delete(postId);
      await interaction.update({ embeds: [buildTradeEmbed(trade, guild)], components: [] });
      await logAction(guild, "🗑️ Trade Deleted", `<@${user.id}> deleted trade \`${postId}\``, 0xe74c3c);
    }

    else if (action === "report") {
      const trade = activeTrades.get(postId);
      if (!trade) return interaction.reply({ content: "❌ Trade not found.", ephemeral: true });
      await interaction.showModal(
        new ModalBuilder().setCustomId(`report_modal_${postId}`).setTitle("🚩 Report Trade Post")
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("reason").setLabel("Reason for reporting")
              .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
              .setPlaceholder("Scammer, fake listing, inappropriate content, etc.")
          ))
      );
    }

    else if (action === "offer") {
      const trade = activeTrades.get(postId);
      if (!trade)                   return interaction.reply({ content: "❌ Trade not found.", ephemeral: true });
      if (trade.userId === user.id) return interaction.reply({ content: "⛔ Can't counter your own listing!", ephemeral: true });
      await interaction.showModal(
        new ModalBuilder().setCustomId(`counter_modal_${postId}`).setTitle("💬 Send a Counter Offer")
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("counter").setLabel("Your offer")
              .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
              .setPlaceholder("e.g. Yami Yami + 20M Beli instead")
          ))
      );
    }

    else if (action === "bookmark") {
      await interaction.reply({ content: `🔖 Bookmarked \`${postId}\`! Use \`/tradeinfo ${postId}\` anytime.`, ephemeral: true });
    }

    else if (action === "share") {
      await interaction.reply({ content: `📤 Share this: Post ID \`${postId}\` — look it up with \`/tradeinfo ${postId}\``, ephemeral: true });
    }

    else if (action === "close" && parts[1] === "ticket") {
      const channelId = parts[2];
      await interaction.reply({ content: "🔒 Closing in **5 seconds**..." });
      setTimeout(() => guild.channels.cache.get(channelId)?.delete("Closed by user").catch(() => {}), 5000);
    }

    else if (action === "trade" && parts[1] === "complete") {
      const tId   = parts[2];
      const trade = activeTrades.get(tId);
      if (trade) {
        trade.status = "completed";
        activeTrades.delete(tId);
        botStats.tradesCompleted++;
        try {
          const ch  = guild.channels.cache.get(trade.channelId);
          const msg = await ch?.messages.fetch(trade.messageId);
          if (msg) await msg.edit({ embeds: [buildTradeEmbed({ ...trade, status: "completed" }, guild)], components: [] });
        } catch {}
        await logAction(guild, "✅ Trade Completed!", `Trade \`${tId}\` completed. 🏴‍☠️`, 0x2ecc71);
      }
      await interaction.reply({ content: "✅ Trade marked **complete**! Congrats, pirates! 🏴‍☠️\nChannel closes in **10 seconds**." });
      setTimeout(() => interaction.channel?.delete("Trade done").catch(() => {}), 10000);
    }

    else if (action === "escalate") {
      const mention = MOD_ROLE_ID ? `<@&${MOD_ROLE_ID}>` : "@Moderators";
      await interaction.reply({ content: `🛡️ ${mention} — mod assistance requested in this trade ticket!` });
    }

    else if (action === "market" && parts[1] === "page") {
      const pageIdx = parseInt(parts[2]);
      const open    = [...activeTrades.values()].filter(t => t.status === "open");
      const pages   = [];
      for (let i = 0; i < open.length; i += 8) pages.push(open.slice(i, i + 8));
      if (pageIdx >= pages.length) return interaction.reply({ content: "No more pages.", ephemeral: true });

      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTitle(`🏪 Sailor Piece Marketplace — Page ${pageIdx + 1}/${pages.length}`)
        .setDescription(pages[pageIdx].map(t =>
          `**\`${t.postId}\`** <@${t.userId}>\n🎁 ${t.offering.slice(0, 70)}...\n🔍 ${t.lookingFor.slice(0, 70)}...`
        ).join("\n\n"))
        .setFooter({ text: `Page ${pageIdx + 1}/${pages.length} • /tradeinfo <postid> for full details` });

      const navRow = new ActionRowBuilder();
      if (pageIdx > 0) navRow.addComponents(
        new ButtonBuilder().setCustomId(`market_page_${pageIdx - 1}`).setLabel("← Previous").setStyle(ButtonStyle.Secondary)
      );
      if (pageIdx + 1 < pages.length) navRow.addComponents(
        new ButtonBuilder().setCustomId(`market_page_${pageIdx + 1}`).setLabel("Next →").setStyle(ButtonStyle.Secondary)
      );

      await interaction.update({ embeds: [embed], components: navRow.components.length ? [navRow] : [] });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN — critical for Railway restarts
// ═══════════════════════════════════════════════════════════════
process.on("SIGINT",  () => { client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { client.destroy(); process.exit(0); });
process.on("unhandledRejection", err => console.error("⚠️ Unhandled rejection:", err));

client.login(TOKEN);
