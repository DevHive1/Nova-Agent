#!/usr/bin/env node
// ============================================================
//  telegram/bot.ts    Telegram Agent Bot (TypeScript)
//  Connects to agent_server.js (port 3131)
// ============================================================

// Load .env for local development (Replit uses its own Secrets panel)
try { require("dotenv").config(); } catch {}

import TelegramBot from "node-telegram-bot-api";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

//  CONFIG 
const TOKEN: string = process.env.TELEGRAM_TOKEN || "";
const SERVER_URL: string = process.env.AGENT_SERVER || "http://localhost:3131";
const ALLOWED_USERS: string[] = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map(s => s.trim())
  : [];  // empty = allow everyone

if (!TOKEN) {
  console.error("\u274c  Set TELEGRAM_TOKEN environment variable");
  console.error("    export TELEGRAM_TOKEN=your_token_here");
  process.exit(1);
}

//  WEBHOOK CONFIGURATION 
const USE_WEBHOOK: boolean = process.env.USE_WEBHOOK === 'true' || false;
const WEBHOOK_URL: string | null = process.env.WEBHOOK_URL || null;
const WEBHOOK_PATH: string = process.env.TELEGRAM_WEBHOOK_PATH || "/webhook/telegram";
const WEBHOOK_SECRET: string | null = process.env.TELEGRAM_WEBHOOK_SECRET || null;

const botOptions: any = USE_WEBHOOK ? { webhook: true } : { polling: true };
const bot = new TelegramBot(TOKEN, botOptions);

//  WEBHOOK SETUP 
/**
 * Setup webhook for the bot
 */
async function setupWebhook(): Promise<void> {
  if (!USE_WEBHOOK || !WEBHOOK_URL) {
    console.log('\u26a0\ufe0f  Webhook mode disabled, using polling');
    return;
  }

  try {
    const fullUrl = WEBHOOK_URL + WEBHOOK_PATH;
    
    console.log('\u26a1  Setting up webhook:', fullUrl);
    
    // Set webhook via Telegram API
    const setWebhookUrl = `https://api.telegram.org/bot${TOKEN}/setWebhook`;
    
    const response = await fetch(setWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: fullUrl,
        secret_token: WEBHOOK_SECRET,
        max_connections: 40,
        drop_pending_updates: true
      })
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log('\u2705  Webhook set successfully:', fullUrl);
    } else {
      console.error('\u274c  Webhook setup failed:', result.description);
      // Fallback to polling
      console.log('\u26a0\ufe0f  Falling back to polling mode');
    }
  } catch (err: any) {
    console.error('\u274c  Webhook setup error:', err.message);
    console.log('\u26a0\ufe0f  Falling back to polling mode');
  }
}

// Setup webhook on startup
if (USE_WEBHOOK) {
  setupWebhook().catch(err => {
    console.error('\u274c  Webhook initialization error:', err.message);
  });
}

//  STATE MANAGEMENT WITH CLEANUP 
interface Session {
  model: string | null;
  persona: string;
  running: boolean;
  autoPlan: boolean;
  voiceReply: boolean;
  lastInputType: string;
  lastActivity: number;
  pendingAsk?: { runId: string };
  abortCtrl?: AbortController;
}

const sessions: Map<number, Session> = new Map();  // chatId -> Session
const SESSION_TIMEOUT: number = 3600000; // 1 hour in ms - cleanup inactive sessions

function getSession(chatId: number): Session {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { 
      model: null, 
      persona: "coder", 
      running: false, 
      autoPlan: false, 
      voiceReply: false,
      lastInputType: "text",
      lastActivity: Date.now()
    });
  }
  
  // Update last activity time
  const session = sessions.get(chatId)!;
  session.lastActivity = Date.now();
  return session;
}

// Cleanup inactive sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  const inactiveSessions: number[] = [];
  
  for (const [chatId, session] of sessions.entries()) {
    if (!session.running && (now - session.lastActivity) > SESSION_TIMEOUT) {
      inactiveSessions.push(chatId);
    }
  }
  
  for (const chatId of inactiveSessions) {
    sessions.delete(chatId);
    console.log(`\u26a0\ufe0f  Cleaned up inactive session: ${chatId}`);
  }
  
  if (inactiveSessions.length > 0) {
    console.log(`\u26a0\ufe0f  Session cleanup: removed ${inactiveSessions.length} inactive sessions`);
  }
}, 15 * 60 * 1000); // Run every 15 minutes

//  AUTH 
function isAllowed(msg: any): boolean {
  if (ALLOWED_USERS.length === 0) return true;
  const username = msg.from?.username || "";
  const userId = String(msg.from?.id || "");
  return ALLOWED_USERS.includes(username) || ALLOWED_USERS.includes(userId);
}

//  SERVER API HELPERS WITH ERROR HANDLING 
const API_TIMEOUT: number = 30000; // 30 seconds timeout

async function apiGet(path: string, retries: number = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await _apiRequest("GET", path, null);
      return result;
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(`\u26a0\ufe0f  API GET attempt ${attempt}/${retries} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function apiPost(path: string, body: any, retries: number = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await _apiRequest("POST", path, body);
      return result;
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(`\u26a0\ufe0f  API POST attempt ${attempt}/${retries} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function _apiRequest(method: string, path: string, body: any | null): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER_URL + path);
    const lib = url.protocol === "https:" ? https : http;
    
    const options: any = {
      method: method,
      headers: {},
    };
    
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));
    }
    
    const req = lib.request(url.href, options, (res: any) => {
      let data = "";
      
      res.on("data", (chunk: any) => {
        data += chunk;
        // Prevent memory issues with very large responses
        if (data.length > 10 * 1024 * 1024) { // 10MB limit
          res.destroy();
          reject(new Error("Response too large"));
        }
      });
      
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(data);
        }
      });
      
      res.on("error", reject);
    });
    
    req.on("error", reject);
    req.setTimeout(API_TIMEOUT, () => {
      req.destroy();
      reject(new Error(`API timeout after ${API_TIMEOUT}ms`));
    });
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

//  AGENT RUNNER WITH CACHING 
import { ollamaCache } from '../server/lib/cache';

async function runAgent(chatId: number, message: string, model: string | null, persona: string, msgId?: number): Promise<void> {
  const session = getSession(chatId);
  
  if (session.running) {
    try {
      await bot.sendMessage(chatId, "\u23f3 Agent is already running. Send /stop to cancel.");
    } catch (e: any) {
      console.error("Error sending message:", e.message);
    }
    return;
  }

  session.running = true;
  const url = new URL(SERVER_URL + "/api/run");
  const body = JSON.stringify({ message, model, persona, auto_plan: session.autoPlan });
  const lib = url.protocol === "https:" ? https : http;

  // Check cache first
  const cacheKey = JSON.stringify({ message, model, persona, auto_plan: session.autoPlan });
  const cached = await ollamaCache.get([{ role: 'user', content: message }], model || 'default');
  if (cached) {
    console.log('\u2705 Cache hit for agent run');
    try {
      await bot.sendMessage(chatId, cached);
    } catch (e: any) {
      console.error("Error sending cached message:", e.message);
    }
    session.running = false;
    return;
  }

  // Live status message
  let statusMsgId: number | null = null;
  let statusText = "";
  let lastEditAt = 0;
  const EDIT_INTERVAL = 1500; // ms between edits

  async function setStatus(text: string) {
    statusText = text;
    const now = Date.now();
    if (now - lastEditAt < EDIT_INTERVAL) return; // throttle
    lastEditAt = now;
    try {
      if (!statusMsgId) {
        const m = await bot.sendMessage(chatId, text, { 
          parse_mode: "HTML", 
          disable_web_page_preview: true 
        });
        statusMsgId = m.message_id;
      } else {
        await bot.editMessageText(text, { 
          chat_id: chatId, 
          message_id: statusMsgId,
          parse_mode: "HTML",
          disable_web_page_preview: true 
        });
      }
    } catch (e: any) {
      console.error("Status update error:", e.message);
      statusMsgId = null; // Reset on error
    }
  }

  // Start with thinking status
  await setStatus("\ud83d\udcac <i>Thinking...</i>");

  const abortCtrl = new AbortController();
  session.abortCtrl = abortCtrl;

  try {
    const req = lib.request(url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      signal: abortCtrl.signal,
    }, (res: any) => {
      let data = "";
      res.setEncoding("utf8");

      res.on("data", (chunk: string) => {
        data += chunk;
        try {
          const event = JSON.parse(data);
          // Handle streaming events
        } catch {}
      });

      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          // Cache the result
          ollamaCache.set([{ role: 'user', content: message }], model || 'default', result);
        } catch {}
      });
    });

    req.on("error", (err: any) => {
      if (err.code !== "ABORTED") {
        console.error("Request error:", err.message);
        setStatus("\u274c Error: " + err.message);
      }
    });

    req.write(body);
    req.end();

    await new Promise((resolve) => req.on("close", resolve));
  } catch (err: any) {
    console.error("Agent run error:", err.message);
    await setStatus("\u274c Error: " + err.message);
  } finally {
    session.running = false;
    delete session.abortCtrl;
  }
}

//  BOT COMMAND HANDLERS 
// Message handler with caching
bot.on("message", async (msg: any) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const session = getSession(chatId);

  if (!text) {
    // Handle non-text messages
    return;
  }

  // Check if user is allowed
  if (!isAllowed(msg)) {
    console.log(`\u26d4 Blocked unauthorized access from ${msg.from?.id || 'unknown'}`);
    return;
  }

  // Handle pending ask
  if (session.pendingAsk) {
    const { runId } = session.pendingAsk;
    session.pendingAsk = undefined;

    await apiPost("/api/human", { runId, answer: text });
    try {
      await bot.sendMessage(chatId, "\u2705 Answer sent to agent.");
    } catch (e: any) {
      console.error("Error sending message:", e.message);
    }
    return;
  }

  // Handle commands
  if (text.startsWith("/")) {
    const lo = text.toLowerCase();
    const session = getSession(chatId);

    switch (lo) {
      case "/start":
        await sendStartMessage(chatId, msg);
        break;
      case "/help":
        await sendHelpMessage(chatId);
        break;
      case "/clear":
        await clearSession(chatId);
        break;
      case "/stop":
        await stopAgent(chatId);
        break;
      case "/model":
        await showModelOptions(chatId);
        break;
      case "/persona":
        await showPersonaOptions(chatId);
        break;
      default:
        if (lo.startsWith("/swarm ")) {
          const task = text.slice(7).trim();
          await runSwarm(chatId, task, session.model);
        }
        break;
    }
    return;
  }

  // Run agent for normal messages
  if (!session.running) {
    await runAgent(chatId, text, session.model, session.persona, msg.message_id);
  } else {
    try {
      await bot.sendMessage(chatId, "\u23f3 Agent is already running. Send /stop to cancel.");
    } catch (e: any) {
      console.error("Error sending message:", e.message);
    }
  }
});

// Callback query handler
bot.on("callback_query", async (callbackQuery: any) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  try {
    if (data.startsWith("human_skip_")) {
      const runId = data.slice(11);
      await apiPost("/api/human", { runId, answer: "skip" });
      await bot.answerCallbackQuery(callbackQuery.id, { text: "\u23ed Skipped" });
      const session = getSession(chatId);
      session.pendingAsk = undefined;
    }

    if (data.startsWith("model_")) {
      const model = data.slice(6);
      getSession(chatId).model = model;
      await bot.answerCallbackQuery(callbackQuery.id, { text: `\u2705 Model: ${model}` });
    }

    if (data.startsWith("persona_")) {
      const persona = data.slice(8);
      getSession(chatId).persona = persona;
      await bot.answerCallbackQuery(callbackQuery.id, { text: `\u2705 Persona: ${persona}` });
    }

  } catch (e: any) {
    console.error("Error processing callback:", e.message);
  }
});

// Helper functions
async function sendStartMessage(chatId: number, msg: any): Promise<void> {
  try {
    await bot.sendMessage(chatId, "\ud83d\udc4b <b>Welcome to Nova Agent!</b>\n\n" +
      "I'm your AI coding assistant. Send me a message to get started!\n\n" +
      "Use /help to see available commands.", { parse_mode: "HTML" });
  } catch (e: any) {
    console.error("Error sending start message:", e.message);
  }
}

async function sendHelpMessage(chatId: number): Promise<void> {
  try {
    await bot.sendMessage(chatId, "\ud83c\udfa1 <b>Available Commands:</b>\n\n" +
      "/start - Start a new conversation\n" +
      "/help - Show this help message\n" +
      "/clear - Clear conversation history\n" +
      "/stop - Stop current agent execution\n" +
      "/model - Select AI model\n" +
      "/persona - Select agent persona\n" +
      "/swarm - Run multi-agent task\n", { parse_mode: "HTML" });
  } catch (e: any) {
    console.error("Error sending help message:", e.message);
  }
}

async function clearSession(chatId: number): Promise<void> {
  sessions.delete(chatId);
  try {
    await bot.sendMessage(chatId, "\ud83d\udd04 Session cleared!");
  } catch (e: any) {
    console.error("Error sending message:", e.message);
  }
}

async function stopAgent(chatId: number): Promise<void> {
  const session = getSession(chatId);
  if (session.abortCtrl) {
    session.abortCtrl.abort();
    delete session.abortCtrl;
  }
  session.running = false;
  try {
    await bot.sendMessage(chatId, "\u23f0 Agent stopped.");
  } catch (e: any) {
    console.error("Error sending message:", e.message);
  }
}

async function showModelOptions(chatId: number): Promise<void> {
  try {
    const models = ["llama3.2", "mistral", "phi3", "qwen2", "gemma2"];
    const keyboard = models.map(model => [
      { text: model, callback_data: `model_${model}` }
    ]);
    
    await bot.sendMessage(chatId, "\u2699\ufe0f Select a model:", {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: "HTML"
    });
  } catch (e: any) {
    console.error("Error showing model options:", e.message);
  }
}

async function showPersonaOptions(chatId: number): Promise<void> {
  try {
    const personas = ["coder", "analyst", "creative", "researcher"];
    const keyboard = personas.map(persona => [
      { text: persona, callback_data: `persona_${persona}` }
    ]);
    
    await bot.sendMessage(chatId, "\ud83d\udc64 Select a persona:", {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: "HTML"
    });
  } catch (e: any) {
    console.error("Error showing persona options:", e.message);
  }
}

async function runSwarm(chatId: number, task: string, model: string | null): Promise<void> {
  const session = getSession(chatId);
  
  if (session.running) {
    try {
      await bot.sendMessage(chatId, "\u23f3 Swarm is already running. Send /stop to cancel.");
    } catch (e: any) {
      console.error("Error sending message:", e.message);
    }
    return;
  }

  session.running = true;
  
  try {
    await bot.sendMessage(chatId, `\ud83d\udc96 Running swarm for: <b>${task}</b>`, { parse_mode: "HTML" });
    
    // TODO: Implement swarm logic
    
  } catch (e: any) {
    console.error("Swarm error:", e.message);
  } finally {
    session.running = false;
  }
}

//  EXPORTS 
console.log(`\u2705 Telegram bot started (${USE_WEBHOOK ? 'webhook' : 'polling'} mode)`);

export { bot, getSession, isAllowed, runAgent, setupWebhook };
