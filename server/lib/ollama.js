// ============================================================
//  server/lib/ollama.js    Ollama HTTP client with retry logic and caching
// ============================================================

const http = require("http");
const https = require("https");
const { OLLAMA_URL, DEFAULT_MODEL } = require("../../shared/constants");

const OLLAMA_RETRY_MAX = 3;
const OLLAMA_RETRY_DELAY = 2000; // base delay in ms
const OLLAMA_TIMEOUT = 300000; // 5 minutes timeout

// Simple in-memory cache for Ollama responses (for development only)
const responseCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache TTL

/**
 * Generate a cache key from messages and model
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} model
 * @returns {string}
 */
function generateCacheKey(messages, model) {
  const messagesString = messages.map(m => `${m.role}:${m.content}`).join("|");
  return `${model}:${messagesString}`;
}

/**
 * Call Ollama /api/chat and return the assistant message content.
 * Automatically retries on rate-limit errors with exponential backoff.
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} [model]
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
async function askOllama(messages, model = DEFAULT_MODEL, timeout = OLLAMA_TIMEOUT) {
  // Check cache first (only for non-streaming requests)
  const cacheKey = generateCacheKey(messages, model);
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.response;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= OLLAMA_RETRY_MAX; attempt++) {
    if (attempt > 0) {
      const delay = OLLAMA_RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`  \u26a0\ufe0f  Ollama rate limited (attempt ${attempt}/${OLLAMA_RETRY_MAX}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await _callOllama(messages, model, timeout);
      
      // Cache the response
      responseCache.set(cacheKey, {
        response: result,
        timestamp: Date.now()
      });
      
      // Clean up old cache entries periodically
      if (Math.random() < 0.1) { // 10% chance to clean up
        const now = Date.now();
        for (const [key, value] of responseCache.entries()) {
          if (now - value.timestamp > CACHE_TTL) {
            responseCache.delete(key);
          }
        }
      }
      
      return result;
    } catch (e) {
      lastError = e;
      // only retry on rate-limit errors
      if (!e.message.includes("429") && !e.message.includes("Too Many") && !e.message.includes("rate")) {
        throw e;
      }
    }
  }

  throw lastError || new Error("Ollama API unavailable after multiple attempts");
}

/**
 * Clear the response cache
 */
function clearCache() {
  responseCache.clear();
}

function _callOllama(messages, model, timeout) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, stream: false, options: { temperature: 0.2 } });
    
    // Determine if we should use http or https
    const url = new URL(`${OLLAMA_URL}/api/chat`);
    const lib = url.protocol === "https:" ? https : http;
    
    const req = lib.request(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let rawResponseText = "";
      res.on("data", c => rawResponseText += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(rawResponseText);
          if (parsed.error) {
            reject(new Error(`Ollama error: ${parsed.error}`));
          } else if (!parsed.message || !parsed.message.content) {
            reject(new Error(`Invalid Ollama response: ${JSON.stringify(parsed).slice(0, 200)}`));
          } else {
            resolve(parsed.message.content);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}\nRaw: ${(rawResponseText || "").slice(0, 200)}`));
        }
      });
    });
    
    req.on("error", reject);
    req.setTimeout(timeout, () => { 
      req.destroy(); 
      reject(new Error("Ollama timeout")); 
    });
    req.write(body);
    req.end();
  });
}

module.exports = { askOllama, clearCache };
