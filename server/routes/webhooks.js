// ============================================================
//  server/routes/webhooks.js    Webhook Support for Telegram Bot
// ============================================================

const express = require("express");
const crypto = require("crypto");
const { getSession, isAllowed, runAgent, runSwarm, sendFinalMessage, sendToolCard } = require("../telegram/webhook-utils");

const router = express.Router();

// Webhook configuration
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || "/webhook/telegram";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;

// Store webhook updates for processing
const pendingUpdates = new Map();

/**
 * Initialize webhook routes
 * @param {Object} bot - Telegram bot instance
 */
function initWebhooks(bot) {
  // Store bot reference for processing
  router.bot = bot;
  
  // Add webhook-specific middleware
  router.use((req, res, next) => {
    req.bot = bot;
    next();
  });
  
  // Add webhook-specific middleware
  router.use((req, res, next) => {
    req.bot = bot;
    next();
  });
  
  // Webhook endpoint
  router.post(WEBHOOK_PATH, express.raw({ type: "application/json" }), async (req, res) => {
    try {
      // Verify webhook secret if configured
      if (WEBHOOK_SECRET) {
        const signature = req.headers["x-telegram-bot-api-secret-token"];
        if (signature !== WEBHOOK_SECRET) {
          console.error("\u274c Invalid webhook secret");
          return res.status(403).json({ error: "Invalid secret" });
        }
      }
      
      // Parse the update
      const update = JSON.parse(req.body);
      
      // Store update for processing
      const updateId = update.update_id || Date.now();
      pendingUpdates.set(updateId, { update, timestamp: Date.now() });
      
      // Process update in background
      processUpdate(update).catch(err => {
        console.error("\u274c Webhook processing error:", err.message);
      });
      
      // Respond immediately
      res.json({ ok: true, update_id: updateId });
      
    } catch (err) {
      console.error("\u274c Webhook error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Health check for webhook
  router.get(WEBHOOK_PATH, (req, res) => {
    res.json({
      ok: true,
      webhook: "active",
      path: WEBHOOK_PATH,
      pendingUpdates: pendingUpdates.size
    });
  });
  
  // Get webhook info
  router.get("/webhook/info", (req, res) => {
    res.json({
      webhookPath: WEBHOOK_PATH,
      secretConfigured: !!WEBHOOK_SECRET,
      pendingUpdates: pendingUpdates.size,
      timestamp: new Date().toISOString()
    });
  });
  
  // Clear pending updates
  router.post("/webhook/clear", (req, res) => {
    pendingUpdates.clear();
    res.json({ ok: true, cleared: true });
  });
  
  // Set webhook endpoint
  router.post("/webhook/setup", async (req, res) => {
    try {
      const { url, secret } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }
      
      // Set webhook via Telegram API
      const botToken = process.env.TELEGRAM_TOKEN;
      if (!botToken) {
        return res.status(400).json({ error: "TELEGRAM_TOKEN not configured" });
      }
      
      const webhookUrl = `${url}${WEBHOOK_PATH}`;
      const setWebhookUrl = `https://api.telegram.org/bot${botToken}/setWebhook`;
      
      const response = await fetch(setWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secret || WEBHOOK_SECRET,
          max_connections: 40,
          drop_pending_updates: true
        })
      });
      
      const result = await response.json();
      
      if (result.ok) {
        console.log("\u2705 Webhook set successfully:", webhookUrl);
        res.json({ ok: true, webhookUrl, result });
      } else {
        console.error("\u274c Webhook setup failed:", result.description);
        res.status(500).json({ error: result.description });
      }
      
    } catch (err) {
      console.error("\u274c Webhook setup error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Delete webhook
  router.post("/webhook/remove", async (req, res) => {
    try {
      const botToken = process.env.TELEGRAM_TOKEN;
      if (!botToken) {
        return res.status(400).json({ error: "TELEGRAM_TOKEN not configured" });
      }
      
      const deleteWebhookUrl = `https://api.telegram.org/bot${botToken}/deleteWebhook`;
      
      const response = await fetch(deleteWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      
      const result = await response.json();
      
      if (result.ok) {
        console.log("\u2705 Webhook removed successfully");
        res.json({ ok: true, result });
      } else {
        console.error("\u274c Webhook removal failed:", result.description);
        res.status(500).json({ error: result.description });
      }
      
    } catch (err) {
      console.error("\u274c Webhook removal error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Get webhook status
  router.get("/webhook/status", async (req, res) => {
    try {
      const botToken = process.env.TELEGRAM_TOKEN;
      if (!botToken) {
        return res.status(400).json({ error: "TELEGRAM_TOKEN not configured" });
      }
      
      const getWebhookUrl = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
      
      const response = await fetch(getWebhookUrl);
      const result = await response.json();
      
      res.json({
        ok: true,
        webhookInfo: result.result || null,
        hasWebhook: result.result && result.result.url,
        timestamp: new Date().toISOString()
      });
      
    } catch (err) {
      console.error("\u274c Webhook status error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  return router;
}

/**
 * Process a Telegram update
 * @param {Object} update - Telegram update object
 */
async function processUpdate(update) {
  const bot = router.bot;
  if (!bot) {
    console.error("\u274c Bot not initialized");
    return;
  }
  
  try {
    const chatId = update.message?.chat?.id || 
                  update.callback_query?.message?.chat?.id ||
                  update.inline_query?.from?.id ||
                  update.chosen_inline_result?.from?.id;
    
    if (!chatId) {
      console.log("\u26a0\ufe0f No chat ID in update:", update.update_id);
      return;
    }
    
    // Check if user is allowed
    const message = update.message || update.callback_query?.message || {};
    if (!isAllowed(message)) {
      console.log(`\u26d4 Blocked unauthorized access from ${message.from?.id || 'unknown'}`);
      return;
    }
    
    // Process different types of updates
    if (update.message) {
      await processMessage(bot, update.message);
    } else if (update.callback_query) {
      await processCallbackQuery(bot, update.callback_query);
    } else if (update.inline_query) {
      await processInlineQuery(bot, update.inline_query);
    } else if (update.chosen_inline_result) {
      await processChosenInlineResult(bot, update.chosen_inline_result);
    } else if (update.channel_post) {
      await processChannelPost(bot, update.channel_post);
    } else if (update.edited_message) {
      await processEditedMessage(bot, update.edited_message);
    } else if (update.edited_channel_post) {
      await processEditedChannelPost(bot, update.edited_channel_post);
    } else if (update.inline_query) {
      await processInlineQuery(bot, update.inline_query);
    }
    
  } catch (err) {
    console.error("\u274c Error processing update:", err.message, err.stack);
  }
}

/**
 * Process a message update
 * @param {Object} bot - Telegram bot instance
 * @param {Object} message - Telegram message object
 */
async function processMessage(bot, message) {
  const chatId = message.chat.id;
  const text = message.text;
  const session = getSession(chatId);
  
  if (!text) {
    // Handle non-text messages (photos, documents, etc.)
    await handleNonTextMessage(bot, message);
    return;
  }
  
  // Handle commands
  if (text.startsWith("/")) {
    await handleCommand(bot, message, text);
    return;
  }
  
  // Handle pending ask
  if (session.pendingAsk) {
    const { runId } = session.pendingAsk;
    session.pendingAsk = null;
    
    await apiPost("/api/human", { runId, answer: text });
    try {
      await bot.sendMessage(chatId, "\u2705 Answer sent to agent.");
    } catch (e) {
      console.error("Error sending message:", e.message);
    }
    return;
  }
  
  // Run agent for normal messages
  if (!session.running) {
    await runAgent(chatId, text, session.model, session.persona, message.message_id);
  } else {
    try {
      await bot.sendMessage(chatId, "\u23f3 Agent is already running. Send /stop to cancel.");
    } catch (e) {
      console.error("Error sending message:", e.message);
    }
  }
}

/**
 * Process a callback query
 * @param {Object} bot - Telegram bot instance
 * @param {Object} query - Telegram callback query object
 */
async function processCallbackQuery(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;
  
  try {
    if (data.startsWith("human_skip_")) {
      const runId = data.slice(11);
      await apiPost("/api/human", { runId, answer: "skip" });
      await bot.answerCallbackQuery(query.id, { text: "\u23ed Skipped" });
      const session = getSession(chatId);
      session.pendingAsk = null;
    }
    
    if (data.startsWith("model_")) {
      const model = data.slice(6);
      getSession(chatId).model = model;
      await bot.answerCallbackQuery(query.id, { text: `\u2705 Model: ${model}` });
      await bot.editMessageText(`\u2705 Model set to: <code>${escHtml(model)}</code>`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML"
      });
    }
    
    if (data.startsWith("persona_")) {
      const persona = data.slice(8);
      getSession(chatId).persona = persona;
      await bot.answerCallbackQuery(query.id, { text: `\u2705 Persona: ${persona}` });
      await bot.editMessageText(`\u2705 Persona set to: <b>${escHtml(persona)}</b>`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML"
      });
    }
    
    if (data.startsWith("confirm_yes_")) {
      const runId = data.slice(12);
      await apiPost("/api/confirm", { runId, confirmed: true });
      await bot.answerCallbackQuery(query.id, { text: "\u2714 Confirmed" });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: messageId
      });
    }
    
    if (data.startsWith("confirm_no_")) {
      const runId = data.slice(11);
      await apiPost("/api/confirm", { runId, confirmed: false });
      await bot.answerCallbackQuery(query.id, { text: "\u2718 Cancelled" });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: messageId
      });
    }
    
  } catch (e) {
    console.error("Error processing callback:", e.message);
  }
}

/**
 * Handle non-text messages (photos, documents, etc.)
 * @param {Object} bot - Telegram bot instance
 * @param {Object} message - Telegram message object
 */
async function handleNonTextMessage(bot, message) {
  const chatId = message.chat.id;
  const session = getSession(chatId);
  
  if (message.photo) {
    await handlePhoto(bot, message);
  } else if (message.document) {
    await handleDocument(bot, message);
  } else if (message.voice) {
    await handleVoice(bot, message);
  }
}

/**
 * Handle photo messages
 */
async function handlePhoto(bot, message) {
  // Implementation for photo handling
  console.log("Photo received:", message.photo);
}

/**
 * Handle document messages
 */
async function handleDocument(bot, message) {
  // Implementation for document handling
  console.log("Document received:", message.document);
}

/**
 * Handle voice messages
 */
async function handleVoice(bot, message) {
  // Implementation for voice handling
  console.log("Voice received:", message.voice);
}

/**
 * Handle commands
 */
async function handleCommand(bot, message, text) {
  const chatId = message.chat.id;
  const lo = text.toLowerCase();
  const session = getSession(chatId);
  
  switch (lo) {
    case "/start":
      await sendStartMessage(bot, chatId, message);
      break;
    case "/help":
      await sendHelpMessage(bot, chatId);
      break;
    case "/status":
      await sendStatusMessage(bot, chatId);
      break;
    case "/clear":
      await clearSession(bot, chatId);
      break;
    case "/stop":
      await stopAgent(bot, chatId);
      break;
    case "/model":
      await showModelOptions(bot, chatId);
      break;
    case "/persona":
      await showPersonaOptions(bot, chatId);
      break;
    case "/swarm":
      // Handle /swarm command
      break;
    default:
      if (lo.startsWith("/swarm ")) {
        const task = text.slice(7).trim();
        await runSwarm(chatId, task, session.model);
      }
      break;
  }
}

/**
 * Helper functions for webhook processing
 */

// Helper functions would be implemented here
// These are placeholders and would be filled with actual implementations

module.exports = {
  initWebhooks,
  WEBHOOK_PATH,
  WEBHOOK_SECRET,
  processUpdate,
  processMessage,
  processCallbackQuery
};
