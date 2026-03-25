import "dotenv/config";
import { Bot, Context } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const HINDSIGHT_URL = process.env.HINDSIGHT_URL || "http://localhost:8888";
const BANK_ID = process.env.HINDSIGHT_BANK_ID || "default";
const VAULT_REPO = process.env.VAULT_REPO || "/tmp/obsidian-vault";
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

// --- Save note to Obsidian vault and push to GitHub ---
async function saveNoteToVault(title: string, content: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `${title}.md`;
  const filepath = path.join(VAULT_REPO, filename);

  const md = `# ${title}\n\n*${date}*\n\n${content}\n`;
  fs.writeFileSync(filepath, md, "utf-8");

  try {
    execSync(
      `cd ${VAULT_REPO} && git add "${filename}" && git commit -m "note: ${title}" && git push`,
      { stdio: "pipe" }
    );
    console.log(`Pushed note: ${filename}`);
  } catch (e: any) {
    console.error("Git push error:", e.message);
    throw e;
  }
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
    return `Релевантные воспоминания:\n${lines}`;
  } catch (e) {
    console.error("Recall error:", e);
    return "";
  }
}

// --- Save to Hindsight + write md file to vault ---
async function retainMemory(noteContent: string, memoryContent?: string): Promise<void> {
  // Save to Hindsight — full context (user + assistant)
  try {
    await hindsight.retain(BANK_ID, memoryContent ?? noteContent);
  } catch (e) {
    console.error("Retain error:", e);
  }

  // Save only user's text as a note in the vault
  try {
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toISOString().slice(11, 19).replace(/:/g, "-");
    const filename = `memory-${date}-${time}.md`;
    const filepath = path.join(VAULT_REPO, filename);
    const md = `# Воспоминание ${date} ${time.replace(/-/g, ":")}\n\n${noteContent}\n`;
    fs.writeFileSync(filepath, md, "utf-8");
    execSync(
      `cd ${VAULT_REPO} && git add "${filename}" && git commit -m "memory: ${date} ${time}" && git push`,
      { stdio: "pipe" }
    );
    console.log(`Saved memory note: ${filename}`);
  } catch (e: any) {
    console.error("Vault save error:", e.message);
  }
}

// --- System prompt ---
function buildSystemPrompt(memories: string): string {
  const base = `Ты личный AI-ассистент пользователя в Telegram. Ты вдумчивый, конкретный и искренне полезный.
Ты помнишь вещи о пользователе со временем и используешь этот контекст чтобы давать более точные ответы.
У тебя есть доступ к личным заметкам и мыслям пользователя — относись к ним с уважением и бережностью.
Всегда отвечай на русском языке.

Если пользователь хочет сохранить мысль или заметку, ответь JSON-объектом в таком формате (и только им, без другого текста):
{"save_note": true, "title": "Название заметки", "content": "Полный текст заметки в маркдауне"}

Сохранять стоит когда пользователь явно говорит "запомни", "сохрани", "запиши", "хочу записать" или явно делится мыслью для сохранения.
В остальных случаях просто отвечай обычным текстом.`;

  if (memories) {
    return `${base}\n\n${memories}`;
  }
  return base;
}

// --- Decide if exchange is worth saving to memory ---
async function shouldRetain(userMessage: string, assistantReply: string): Promise<{ retain: boolean; reason?: string }> {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 100,
      system: `Ты решаешь стоит ли сохранить обмен сообщениями в долгосрочную память.
Сохрани если: пользователь поделился чем-то личным, выразил мнение, рассказал о себе, своих планах, переживаниях, предпочтениях.
НЕ сохраняй если: это просто вопрос-ответ, мелкий чат, команды боту, технические запросы.
Ответь только JSON: {"retain": true/false}`,
      messages: [
        { role: "user", content: `User: ${userMessage}\nAssistant: ${assistantReply}` }
      ],
    });
    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    return JSON.parse(text);
  } catch {
    return { retain: false };
  }
}


// --- /start ---
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я знаю твои заметки и помню наши разговоры.\n\nПросто напиши мне что-нибудь, или скажи *«запомни»* — и я сохраню мысль в Obsidian 👋",
    { parse_mode: "Markdown" }
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
  const query = ctx.match || "что ты знаешь обо мне";
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

bot.on("message:text", async (ctx: Context) => {
  const chatId = ctx.chat!.id;
  const userMessage = ctx.message!.text!;

  // Skip commands — handled by bot.command()
  if (userMessage.startsWith("/")) return;

  await ctx.replyWithChatAction("typing");

  const history = getHistory(chatId);
  const memories = await recallMemories(userMessage);

  history.push({ role: "user", content: userMessage });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(memories),
      messages: history.slice(-20),
    });

    const assistantText =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Check if model wants to save a note
    let replyText = assistantText;
    try {
      const parsed = JSON.parse(assistantText.trim());
      if (parsed.save_note && parsed.title && parsed.content) {
        await ctx.replyWithChatAction("typing");

        // Save to vault and push
        await saveNoteToVault(parsed.title, parsed.content);

        // Save to Hindsight
        retainMemory(`# ${parsed.title}\n\n${parsed.content}`);

        replyText = `✅ Сохранено в Obsidian: *${parsed.title}*`;
        history.push({ role: "assistant", content: replyText });
        await ctx.reply(replyText, { parse_mode: "Markdown" });
        return;
      }
    } catch {
      // Not JSON — normal reply
    }

    history.push({ role: "assistant", content: replyText });
    await ctx.reply(replyText, { parse_mode: "Markdown" });

    // Save to Hindsight only if worth remembering
    const { retain } = await shouldRetain(userMessage, replyText);
    if (retain) {
      retainMemory(userMessage, `User: ${userMessage}\nAssistant: ${replyText}`);
      console.log("Retained exchange.");
    }
  } catch (err) {
    console.error("LLM error:", err);
    await ctx.reply("Произошла ошибка, попробуй ещё раз.");
    history.pop();
  }
});

// --- Start bot with retry on 409 ---
async function startBot() {
  while (true) {
    try {
      console.log("Starting Hindsight bot...");
      await bot.start({
        onStart: () => console.log("Bot is running!"),
      });
      break;
    } catch (err: any) {
      if (err?.error_code === 409 || String(err).includes("409")) {
        console.log("409 Conflict — retrying in 35s...");
        bot.isRunning() && await bot.stop();
        await new Promise(r => setTimeout(r, 35000));
      } else {
        console.error("Fatal error:", err);
        process.exit(1);
      }
    }
  }
}

process.on("uncaughtException", (err: any) => {
  if (err?.error_code === 409 || String(err).includes("409")) {
    console.log("Uncaught 409, will restart...");
    setTimeout(() => startBot(), 35000);
  } else {
    console.error("Uncaught exception:", err);
    process.exit(1);
  }
});

startBot();
