import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import OpenAI from "openai";
import pkg from "pg";
const { Pool } = pkg;

// --- env (Railway Variables) ---
const {
  DISCORD_TOKEN,          // your bot token
  DISCORD_CLIENT_ID,      // application ID from Dev Portal
  OPENAI_API_KEY,         // your OpenAI key
  DATABASE_URL            // Railway Postgres URL (auto-provisioned)
} = process.env;

// --- clients ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const db = new Pool({ connectionString: DATABASE_URL });

// --- bootstrap DB ---
async function initDb() {
  await db.query(`
    create table if not exists messages (
      id bigserial primary key,
      guild_id text,
      channel_id text,
      user_id text,
      role text check (role in ('user','assistant')),
      content text not null,
      created_at timestamptz default now()
    );
  `);
  await db.query(`
    create table if not exists user_memory (
      user_id text primary key,
      summary text not null default '',
      updated_at timestamptz default now()
    );
  `);
}

// --- memory helpers ---
async function fetchShortHistory(channel_id, limit = 10) {
  const { rows } = await db.query(
    `select role, content from messages
     where channel_id = $1
     order by id desc
     limit $2`, [channel_id, limit]
  );
  return rows.reverse(); // oldest->newest for context
}

async function fetchUserSummary(user_id) {
  const { rows } = await db.query(`select summary from user_memory where user_id = $1`, [user_id]);
  return rows[0]?.summary || "";
}

async function upsertUserSummary(user_id, interactionText) {
  // Ask OpenAI to update a concise long-term memory for this user
  const system = `You write ONE short bullet capturing stable, helpful facts about the user for future chats.
Keep it under 40 words. If nothing new, return the existing summary unchanged.`;
  const current = await fetchUserSummary(user_id);
  const prompt = `Current summary: "${current || "(none)"}"
New message from user: "${interactionText}"
Return: one-sentence updated summary ONLY.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    temperature: 0.2
  });

  const updated = resp.choices[0].message.content.trim();
  await db.query(`
    insert into user_memory(user_id, summary, updated_at)
    values ($1,$2,now())
    on conflict (user_id) do update set summary = $2, updated_at = now()
  `, [user_id, updated]);
  return updated;
}

// --- reply with OpenAI using memory ---
async function generateReply({ guild_id, channel_id, user_id, userText }) {
  const short = await fetchShortHistory(channel_id, 10);
  const summary = await fetchUserSummary(user_id);

  const system = `You are an upbeat, helpful coding assistant living in a small Discord server called "jeljel6’s Dev Server".
Keep answers concise, accurate, and friendly. Prefer code blocks and minimal steps.`;

  const messages = [
    { role: "system", content: system },
    { role: "system", content: `User long-term memory: ${summary || "(none)"}` },
    ...short.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userText }
  ];

  // OpenAI chat completion (official SDK)
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.4
  });

  const content = resp.choices[0].message.content.trim();
  return content;
}

// --- slash commands (/memory, /forget, /reset) ---
const commands = [
  new SlashCommandBuilder().setName("memory").setDescription("Show your long-term memory."),
  new SlashCommandBuilder().setName("forget").setDescription("Erase your long-term memory."),
  new SlashCommandBuilder().setName("reset").setDescription("Clear channel short-term context.")
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
}

// --- event handlers ---
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDb();
  try { await registerCommands(); } catch (e) { console.error("Cmd deploy failed", e); }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "memory") {
    const summary = await fetchUserSummary(interaction.user.id);
    await interaction.reply({ content: summary || "No long-term memory stored yet.", ephemeral: true });
  }

  if (interaction.commandName === "forget") {
    await db.query(`delete from user_memory where user_id = $1`, [interaction.user.id]);
    await interaction.reply({ content: "Your long-term memory was erased.", ephemeral: true });
  }

  if (interaction.commandName === "reset") {
    await db.query(`delete from messages where channel_id = $1`, [interaction.channelId]);
    await interaction.reply({ content: "This channel's short-term memory was cleared.", ephemeral: true });
  }
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  // store the user message
  await db.query(
    `insert into messages(guild_id, channel_id, user_id, role, content)
     values ($1,$2,$3,'user',$4)`,
    [msg.guildId, msg.channelId, msg.author.id, msg.content]
  );

  // Only respond when bot is mentioned or a prefix is used
  const addressed = msg.mentions.has(client.user) || msg.content.startsWith("!");
  if (!addressed) return;

  const userText = msg.content.replace(/^!\s*/,'').replace(`<@${client.user.id}>`, "").trim();
  if (!userText) return;

  try {
    const reply = await generateReply({
      guild_id: msg.guildId,
      channel_id: msg.channelId,
      user_id: msg.author.id,
      userText
    });

    await msg.channel.send(reply);

    // store the assistant reply
    await db.query(
      `insert into messages(guild_id, channel_id, user_id, role, content)
       values ($1,$2,$3,'assistant',$4)`,
      [msg.guildId, msg.channelId, client.user.id, reply]
    );

    // update long-term summary
    await upsertUserSummary(msg.author.id, msg.content);
  } catch (err) {
    console.error(err);
    await msg.channel.send("Oops—something went wrong. Try again in a moment.");
  }
});

client.login(DISCORD_TOKEN);import { REST, Routes } from "discord.js";
import { SlashCommandBuilder } from "discord.js";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;

const commands = [
  new SlashCommandBuilder().setName("memory").setDescription("Show your long-term memory."),
  new SlashCommandBuilder().setName("forget").setDescription("Erase your long-term memory."),
  new SlashCommandBuilder().setName("reset").setDescription("Clear channel short-term context.")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log("Slash commands deployed.");
})();