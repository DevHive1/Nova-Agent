import express from "express";
// ============================================================
//  server/routes/webhooks.ts    Webhook Support for Telegram Bot (TypeScript)
// ============================================================


const router: Router = express.Router();

// Webhook configuration
const WEBHOOK_PATH: string = process.env.TELEGRAM_WEBHOOK_PATH || "/webhook/telegram";
const WEBHOOK_SECRET: string | null = process.env.TELEGRAM_WEBHOOK_SECRET || null;

// Store webhook updates for processing
const pendingUpdates: Map<number, { update: any; timestamp: number }> = new Map();

// Bot reference will be set when initialized
let botInstance: any = null;

/**
 * Initialize webhook routes
 * @param bot - Telegram bot instance
 */
function initWebhooks(bot: any): Router {
  // Store bot reference for processing
  botInstance = bot;
  router.bot = bot;
  
  // Add webhook-specific middleware
  router.use((req: Request, res: Response, next: () => void) => {
    (req as any).bot = bot;
    next();
  });

  // Webhook endpoint
  router.post(WEBHOOK_PATH, express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    try {
      // Verify webhook secret if configured
      if (WEBHOOK_SECRET) {
        const signature = req.headers["x-telegram-bot-api-secret-token"] as string;
        if (signature !== WEBHOOK_SECRET) {
          console.error("\u274c Invalid webhook secret");
          return res.status(403).json({ error: "Invalid secret" });
        }
      }
      
      // Parse the update
      const update = JSON.parse(req.body as any);
      
      // Store update for processing
      const updateId = update.update_id || Date.now();
      pendingUpdates.set(updateId, { update, timestamp: Date.now() });
      
      // Process update in background
      processUpdate(update).catch(err => {
        console.error("\u274c Webhook processing error:", err.message);
      });
      
      // Respond immediately
      res.json({ ok: true, update_id: updateId });
      
    } catch (err: any) {
      console.error("\u274c Webhook error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Health check for webhook
  router.get(WEBHOOK_PATH, (req: Request, res: Response) => {
    res.json({
      ok: true,
      webhook: "active",
      path: WEBHOOK_PATH,
      pendingUpdates: pendingUpdates.size
    });
  });
  
  // Get webhook info
  router.get("/webhook/info", (req: Request, res: Response) => {
    res.json({
      webhookPath: WEBHOOK_PATH,
      secretConfigured: !!WEBHOOK_SECRET,
      pendingUpdates: pendingUpdates.size,
      timestamp: new Date().toISOString()
    });
  });
  
  // Clear pending updates
  router.post("/webhook/clear", (req: Request, res: Response) => {
    pendingUpdates.clear();
    res.json({ ok: true, cleared: true });
  });
  
  // Set webhook endpoint
  router.post("/webhook/setup", async (req: Request, res: Response) => {
    try {
      const { url, secret } = req.body as { url?: string; secret?: string };
      
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
      
    } catch (err: any) {
      console.error("\u274c Webhook setup error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Delete webhook
  router.post("/webhook/remove", async (req: Request, res: Response) => {
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
      
    } catch (err: any) {
      console.error("\u274c Webhook removal error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Get webhook status
  router.get("/webhook/status", async (req: Request, res: Response) => {
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
      
    } catch (err: any) {
      console.error("\u274c Webhook status error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
  
  return router;
}

/**
 * Check if user is allowed to access the bot
 * @param msg - Telegram message object
 * @returns True if user is allowed
 */
function isAllowed(msg: any): boolean {
  const ALLOWED_USERS = process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(",").map(s => s.trim())
    : [];
  if (ALLOWED_USERS.length === 0) return true;
  const username = msg.from?.username || "";
  const userId = String(msg.from?.id || "");
  return ALLOWED_USERS.includes(username) || ALLOWED_USERS.includes(userId);
}

/**
 * Process a Telegram update
 * @param update - Telegram update object
 */
async function processUpdate(update: any): Promise<void> {
  const bot = botInstance;
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
    }
    
  } catch (err: any) {
    console.error("\u274c Error processing update:", err.message, err.stack);
  }
}

/**
 * Process a message update
 * @param bot - Telegram bot instance
 * @param message - Telegram message object
 */
async function processMessage(bot: any, message: any): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text;
  
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
}

/**
 * Process a callback query
 * @param bot - Telegram bot instance
 * @param query - Telegram callback query object
 */
async function processCallbackQuery(bot: any, query: any): Promise<void> {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;
  
  try {
    if (data.startsWith("human_skip_")) {
      const runId = data.slice(11);
      await apiPost("/api/human", { runId, answer: "skip" });
      await bot.answerCallbackQuery(query.id, { text: "\u23ed Skipped" });
    }
    
    if (data.startsWith("model_")) {
      const model = data.slice(6);
      getSession(chatId).model = model;
      await bot.answerCallbackQuery(query.id, { text: `\u2705 Model: ${model}` });
    }
    
    if (data.startsWith("persona_")) {
      const persona = data.slice(8);
      getSession(chatId).persona = persona;
      await bot.answerCallbackQuery(query.id, { text: `\u2705 Persona: ${persona}` });
    }
    
  } catch (e: any) {
    console.error("Error processing callback:", e.message);
  }
}

// Helper functions (would be implemented from bot.js)
function getSession(chatId: number): any {
  // This would be imported from bot.js in the actual implementation
  return { model: null, persona: null };
}

async function apiPost(path: string, body: any): Promise<any> {
  // This would be imported from bot.js in the actual implementation
  return {};
}

async function handleNonTextMessage(bot: any, message: any): Promise<void> {
  // Implementation for non-text messages
  console.log("Non-text message received:", message);
}

async function handleCommand(bot: any, message: any, text: string): Promise<void> {
  // Implementation for commands
  console.log("Command received:", text);
}

// Export router and functions
interface WebhooksRouter extends Router {
  bot?: any;
}

const webhooksRouter: WebhooksRouter = router as any;

export {
  initWebhooks,
  WEBHOOK_PATH,
  WEBHOOK_SECRET,
  processUpdate,
  processMessage,
  processCallbackQuery,
  webhooksRouter as router
};

export default router;
