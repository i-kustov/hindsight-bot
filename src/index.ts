import "dotenv/config";
import { Bot, Context } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { HindsightClient } from "@vectorize-io/hindsight-client";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const HINDSIGHT_URL = process.env.HINDSIGHT_URL || "http://localhost:8888";
const BANK_ID = process.env.HINDSIGHT_BANK_ID || "default";
const MODEL = "claude-sonnet-4-6";

// --- Clients ---
const bot = new Bot(BOT_TOKEN);

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL,
});

const hindsight = new HindsightClient({ baseUrl: HINDSIGHT_URL });

// --- Conversation history (in-memory, per chat) ---
const histories = new Map<number, { role: "user" | "assistant"; content: string }[]>();

function getHistory(chatId: number) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId)!;
}

// --- Recall memories relevant to message ---
async function recallMemories(query: string): Promise<string> {
  try {
    const result = await hindsight.recall(BANK_ID, query);
    if (!result.results || result.results.length === 0) return "";

    const lines = result.results
      .slice(0, 5)
      .map((r: any) => `- ${r.text}`)
      .join("\n");

    return `Relevant memories:\n${lines}`;
  } catch (e) {
    console.error("Recall error:", e);
    return "";
  }
}

// --- Save message to memory ---
async function retainMemory(content: string): Promise<void> {
  try {
    await hindsight.retain(BANK_ID, content);
  } catch (e) {
    console.error("Retain error:", e);
  }
}

// --- System prompt ---
function buildSystemPrompt(memories: string): string {
  const base = `You are a personal AI assistant in Telegram. You're thoughtful, concise, and genuinely helpful.
You remember things about the user over time and use that context to give better responses.
Respond in the same language the user writes in.`;

  if (memories) {
    return `${base}\n\n${memories}`;
  }
  return base;
}

// --- Handle message ---
bot.on("message:text", async (ctx: Context) => {
  const chatId = ctx.chat!.id;
  const userMessage = ctx.message!.text!;

  // Show typing indicator
  await ctx.replyWithChatAction("typing");

  const history = getHistory(chatId);

  // Recall relevant memories
  const memories = await recallMemories(userMessage);

  // Build messages for Claude
  history.push({ role: "user", content: userMessage });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(memories),
      messages: history.slice(-20), // keep last 20 turns
    });

    const assistantText =
      response.content[0].type === "text" ? response.content[0].text : "";

    history.push({ role: "assistant", content: assistantText });

    // Reply to user
    await ctx.reply(assistantText, { parse_mode: "Markdown" });

    // Save the exchange to Hindsight (async, don't await)
    retainMemory(`User: ${userMessage}\nAssistant: ${assistantText}`);
  } catch (err) {
    console.error("LLM error:", err);
    await ctx.reply("Произошла ошибка, попробуй ещё раз.");
    history.pop(); // remove failed user message
  }
});

// --- /start ---
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я помню наши разговоры и учусь со временем. Просто напиши мне что-нибудь 👋"
  );
});

// --- /forget ---
bot.command("forget", async (ctx) => {
  const chatId = ctx.chat!.id;
  histories.delete(chatId);
  await ctx.reply("История этого разговора очищена. Начинаем с чистого листа.");
});

// --- /memory ---
bot.command("memory", async (ctx) => {
  const query = ctx.match || "what do you know about me";
  try {
    const result = await hindsight.recall(BANK_ID, query);
    if (!result.results || result.results.length === 0) {
      await ctx.reply("Пока ничего не запомнил 🤷");
      return;
    }
    const lines = result.results
      .slice(0, 8)
      .map((r: any, i: number) => `${i + 1}. ${r.text}`)
      .join("\n\n");
    await ctx.reply(`🧠 Что я знаю:\n\n${lines}`);
  } catch (e) {
    await ctx.reply("Не могу достать воспоминания.");
  }
});

// --- Start bot ---
console.log("Starting Hindsight bot...");
bot.start({
  onStart: () => console.log("Bot is running!"),
});
