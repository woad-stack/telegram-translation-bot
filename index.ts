import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Telegraf, Context, MiddlewareFn } from "telegraf";
import { translate as googleTranslate } from "@vitalets/google-translate-api";
import type { Message } from "telegraf/typings/core/types/typegram";

dotenv.config();

// ---------- Types ----------

interface UserPrefs {
  [userId: string]: {
    targetLang: string;
    updatedAt: string;
  };
}

// 为群组设置添加类型定义
interface GroupPrefs {
  [chatId: string]: {
    targetLang: string;
    updatedAt: string;
  };
}

// ---------- Config ----------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in environment");
}

const DEFAULT_TARGET_LANG = "zh"; // 全局最终回退的默认语言
const USER_PREFS_FILE = path.resolve(process.cwd(), "user-prefs.json");
const GROUP_PREFS_FILE = path.resolve(process.cwd(), "group-prefs.json"); // +++ NEW

const ALLOWED_LANGS = new Set([
  "zh",
  "en",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "ru",
  "pt",
  "it",
  "ar",
  "hi",
  "th",
  "vi",
  "id",
  "tr",
  "nl",
  "pl",
  "sv",
  "uk",
  "he",
]);

function isValidLang(code: string): boolean {
  const lc = code.trim().toLowerCase();
  return ALLOWED_LANGS.has(lc);
}

// ---------- Storage Classes ----------

// 存储基类，用于复用 load/save 逻辑
class PrefsStore<T> {
  protected file: string;
  protected cache: T;

  constructor(file: string, defaultValue: T) {
    this.file = file;
    this.cache = this.load(defaultValue);
  }

  private load(defaultValue: T): T {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        return JSON.parse(raw) as T;
      }
    } catch (e) {
      console.error(`Failed to load prefs file: ${this.file}`, e);
    }
    return defaultValue;
  }

  protected save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf8");
    } catch (e) {
      console.error(`Failed to save prefs file: ${this.file}`, e);
    }
  }
}

class UserPrefsStore extends PrefsStore<UserPrefs> {
  constructor(file: string) {
    super(file, {});
  }
  getTargetLang(userId: number): string | undefined {
    return this.cache[String(userId)]?.targetLang;
  }
  setTargetLang(userId: number, lang: string) {
    this.cache[String(userId)] = {
      targetLang: lang,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }
}

// 群组设置的存储类
class GroupPrefsStore extends PrefsStore<GroupPrefs> {
  constructor(file: string) {
    super(file, {});
  }
  getTargetLang(chatId: number): string | undefined {
    return this.cache[String(chatId)]?.targetLang;
  }
  setTargetLang(chatId: number, lang: string) {
    this.cache[String(chatId)] = {
      targetLang: lang,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }
}

const userStore = new UserPrefsStore(USER_PREFS_FILE);
const groupStore = new GroupPrefsStore(GROUP_PREFS_FILE); // +++ NEW

// ---------- Translation & Utilities ----------

async function translate(text: string, targetLang: string): Promise<string> {
  try {
    const { text: translatedText } = await googleTranslate(text, {
      to: targetLang,
    });
    return translatedText;
  } catch (error) {
    console.error("Google Translate API error:", error);
    throw new Error("Translation failed");
  }
}

function isCommand(text?: string): boolean {
  return !!text && text.startsWith("/");
}

function trimCode(s: string | undefined): string {
  return (s || "").trim().toLowerCase();
}

function getTextFromMessage(
  msg: Message.TextMessage | Message.CaptionableMessage
): string | undefined {
  if ("text" in msg) return msg.text;
  if ("caption" in msg) return msg.caption;
  return undefined;
}

// ---------- Bot setup ----------

const bot = new Telegraf(TOKEN);

// Middleware: ignore messages from other bots
const ignoreBots: MiddlewareFn<Context> = async (ctx, next) => {
  if (ctx.from?.is_bot) return;
  return next();
};
bot.use(ignoreBots);

// --- MODIFIED: 更新帮助和开始信息
bot.start(async (ctx) => {
  await ctx.reply(
    "👋 已启动：本机器人会翻译群内消息。\n\n" +
      "👤 **个人设置:**\n" +
      "`/setlang en` - 将为你翻译成英文。\n" +
      "`/getlang` - 查看你的个人设置。\n\n" +
      "👑 **群组管理员设置:**\n" +
      "`/setdefaultlang ja` - 将本群的默认翻译语言设为日语。\n\n" +
      "默认情况下，所有消息都会被翻译成中文。",
    { parse_mode: "Markdown" }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "帮助信息:\n" +
      "`/setlang <code>` - 设置你个人的翻译目标语言 (例如: en, ja)。\n" +
      "`/getlang` - 查看你当前的目标语言。\n\n" +
      "👑 **仅限群主和管理员:**\n" +
      "`/setdefaultlang <code>` - 设置本群的默认翻译语言。\n\n" +
      "翻译优先级: 个人设置 > 群组默认设置 > 全局默认 (中文)。",
    { parse_mode: "Markdown" }
  );
});

// /setlang (个人设置)
bot.command("setlang", async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const lang = trimCode(parts[1]);

  if (!lang) {
    await ctx.reply("用法: /setlang <语言代码>, 例如 /setlang en");
    return;
  }
  if (!isValidLang(lang)) {
    await ctx.reply(`不支持的语言代码: ${lang}`);
    return;
  }

  userStore.setTargetLang(ctx.from.id, lang);
  await ctx.reply(`你的个人翻译语言已设置为 ${lang.toUpperCase()}。`);
});

// /getlang (个人设置)
bot.command("getlang", async (ctx) => {
  const userLang = userStore.getTargetLang(ctx.from.id);
  const groupLang = groupStore.getTargetLang(ctx.chat.id);

  let replyText = `你的个人目标语言: ${(userLang || "未设置").toUpperCase()}\n`;
  if (ctx.chat.type !== "private") {
    replyText += `当前群组默认语言: ${(
      groupLang || DEFAULT_TARGET_LANG
    ).toUpperCase()}`;
  }
  await ctx.reply(replyText);
});

// /setdefaultlang (群组设置)
bot.command("setdefaultlang", async (ctx) => {
  if (ctx.chat.type === "private") {
    await ctx.reply("此命令只能在群组中使用。");
    return;
  }

  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (member.status !== "creator" && member.status !== "administrator") {
      await ctx.reply("抱歉，只有群主或管理员才能修改群组的默认翻译语言。");
      return;
    }
  } catch (error) {
    console.error("Failed to get chat member:", error);
    await ctx.reply("无法验证你的权限，请确保机器人拥有管理员权限。");
    return;
  }

  const parts = ctx.message.text.split(/\s+/);
  const lang = trimCode(parts[1]);

  if (!lang) {
    await ctx.reply(
      "用法: /setdefaultlang <语言代码>, 例如 /setdefaultlang ja"
    );
    return;
  }
  if (!isValidLang(lang)) {
    await ctx.reply(`不支持的语言代码: ${lang}`);
    return;
  }

  groupStore.setTargetLang(ctx.chat.id, lang);
  await ctx.reply(`本群的默认翻译语言已设置为 ${lang.toUpperCase()}。`);
});

// --- MODIFIED: 核心翻译逻辑
bot.on(["message", "edited_message"], async (ctx) => {
  const msg =
    "message" in ctx.update ? ctx.update.message : ctx.update.edited_message;
  if (!msg || !("text" in msg || "caption" in msg)) return;

  const text = getTextFromMessage(msg);
  if (!text || isCommand(text)) return;

  const senderId = msg.from?.id;
  if (!senderId) return;

  // 新的优先级逻辑
  const userLang = userStore.getTargetLang(senderId);
  const groupLang = groupStore.getTargetLang(msg.chat.id);
  const targetLang = userLang || groupLang || DEFAULT_TARGET_LANG;

  try {
    const translated = await translate(text, targetLang);
    // 如果翻译结果和原文一样，则不回复，避免在不需要翻译时刷屏
    if (translated.trim().toLowerCase() === text.trim().toLowerCase()) {
      return;
    }

    await ctx.reply(translated, {
      reply_parameters: {
        message_id: msg.message_id,
        allow_sending_without_reply: true,
      },
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("Translate failed:", err);
    // 翻译失败时不再打扰用户
  }
});

// ---------- Launch ----------

bot
  .launch({
    // 在启动时丢弃离线期间积攒的旧消息
    dropPendingUpdates: true,
  })
  .then(() => {
    console.log("🚀 Translator bot is running");
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
