// ============================================================
//  server/lib/ollama.ts    Ollama Client (TypeScript)
// ============================================================

import fetch from "node-fetch";
import { ollamaCache } from './cache';

const OLLAMA_URL: string = process.env.OLLAMA_URL || "http://localhost:11434";
const DEFAULT_MODEL: string = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_RETRY_MAX: number = 3;
const OLLAMA_RETRY_DELAY: number = 2000; // base delay in ms
const OLLAMA_TIMEOUT: number = 300000; // 5 minutes timeout

/**
 * Generate a cache key from messages and model
 * @param messages - Array of message objects
 * @param model - Model name
 * @returns Cache key string
 */
function generateCacheKey(messages: any[], model: string): string {
  const messagesString = messages.map(m => `${m.role}:${m.content}`).join("|");
  return `${model}:${messagesString}`;
}

/**
 * Ask Ollama API with retry logic and caching
 * @param messages - Array of message objects
 * @param model - Model to use
 * @param options - Additional options
 * @returns Ollama response
 */
export async function askOllama(messages: any[], model: string = DEFAULT_MODEL, options: { noCache?: boolean } = {}): Promise<any> {
  // Check cache first
  const cached = await ollamaCache.get(messages, model);
  if (cached) {
    return cached;
  }

  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= OLLAMA_RETRY_MAX; attempt++) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as any;

      // Cache the response
      if (result && !options.noCache) {
        await ollamaCache.set(messages, model, result);
      }

      return result;
    } catch (err: any) {
      lastError = err;
      if (attempt < OLLAMA_RETRY_MAX) {
        const delay = OLLAMA_RETRY_DELAY * Math.pow(2, attempt - 1);
        console.log(`\u26a0\ufe0f  Ollama attempt ${attempt}/${OLLAMA_RETRY_MAX} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Ollama request failed");
}

/**
 * Check if Ollama is running
 * @returns True if Ollama is accessible
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get available models from Ollama
 * @returns Array of model names
 */
export async function getOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    return result.models.map((m: any) => m.name);
  } catch {
    return [];
  }
}

export { OLLAMA_URL, DEFAULT_MODEL };
