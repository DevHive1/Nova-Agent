// ============================================================
//  server/lib/cache.ts    Redis-based Caching Layer (TypeScript)
// ============================================================


// Configuration
const REDIS_URL: string = process.env.REDIS_URL || 'redis://localhost:6379';
const CACHE_TTL: number = parseInt(process.env.CACHE_TTL || '300'); // 5 minutes default
const MAX_CACHE_SIZE: number = parseInt(process.env.MAX_CACHE_SIZE || '10000'); // Max cache entries

// Cache prefixes
const CACHE_PREFIXES = {
  OLLAMA: 'ollama:',
  FILE: 'file:',
  SESSION: 'session:',
  SWARM: 'swarm:',
  GENERIC: 'cache:'
} as const;

// In-memory fallback cache (when Redis is not available)
const memoryCache: Map<string, { value: any; timestamp: number; ttl: number }> = new Map();
let redisClient: any | null = null;
let isRedisAvailable: boolean = false;

/**
 * Initialize Redis client
 */
async function initCache(): Promise<boolean> {
  try {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        reconnectStrategy: (retries: number) => Math.min(retries * 100, 5000) // Exponential backoff
      }
    });

    redisClient.on('error', (err: Error) => {
      console.error('\u274c Redis error:', err.message);
      isRedisAvailable = false;
    });

    redisClient.on('connect', () => {
      console.log('\u2705 Redis connected');
      isRedisAvailable = true;
    });

    redisClient.on('reconnecting', () => {
      console.log('\u26a0\ufe0f Redis reconnecting...');
    });

    await redisClient.connect();
    isRedisAvailable = true;
    
    // Test connection
    await redisClient.ping();
    console.log('\u2705 Redis cache initialized');
    
    return true;
  } catch (err: any) {
    console.warn('\u26a0\ufe0f Redis not available, using in-memory cache:', err?.message);
    isRedisAvailable = false;
    return false;
  }
}

/**
 * Generate cache key from parameters
 * @param prefix - Cache prefix
 * @param parts - Key parts to concatenate
 * @returns Cache key string
 */
function generateCacheKey(prefix: string, ...parts: any[]): string {
  const keyParts = parts.map(part => {
    if (typeof part === 'object' && part !== null) {
      return JSON.stringify(part);
    }
    return String(part);
  });
  return prefix + keyParts.join(':');
}

/**
 * Get value from cache
 * @param key - Cache key
 * @returns Cached value or null
 */
async function getCache(key: string): Promise<any> {
  if (!key) return null;

  try {
    if (isRedisAvailable && redisClient) {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } else {
      // In-memory fallback
      const cached = memoryCache.get(key);
      if (cached && Date.now() - cached.timestamp < cached.ttl * 1000) {
        return cached.value;
      }
      return null;
    }
  } catch (err: any) {
    console.error('\u274c Cache get error:', err?.message);
    return null;
  }
}

/**
 * Set value in cache
 * @param key - Cache key
 * @param value - Value to cache
 * @param ttl - Time to live in seconds
 * @returns Success status
 */
async function setCache(key: string, value: any, ttl: number = CACHE_TTL): Promise<boolean> {
  if (!key) return false;

  try {
    const cacheValue = JSON.stringify(value);
    
    if (isRedisAvailable && redisClient) {
      await redisClient.set(key, cacheValue, {
        EX: ttl
      });
      
      // Clean up old keys if cache is getting too large
      if (Math.random() < 0.01) { // 1% chance to cleanup
        await cleanupCache();
      }
      
      return true;
    } else {
      // In-memory fallback with automatic cleanup
      memoryCache.set(key, {
        value,
        timestamp: Date.now(),
        ttl
      });
      
      // Clean up old entries
      if (memoryCache.size > MAX_CACHE_SIZE) {
        cleanupMemoryCache();
      }
      
      return true;
    }
  } catch (err: any) {
    console.error('\u274c Cache set error:', err?.message);
    return false;
  }
}

/**
 * Delete value from cache
 * @param key - Cache key
 * @returns Success status
 */
async function delCache(key: string): Promise<boolean> {
  try {
    if (isRedisAvailable && redisClient) {
      await redisClient.del(key);
    } else {
      memoryCache.delete(key);
    }
    return true;
  } catch (err: any) {
    console.error('\u274c Cache delete error:', err?.message);
    return false;
  }
}

/**
 * Clear all cache entries
 * @returns Success status
 */
async function clearCache(): Promise<boolean> {
  try {
    if (isRedisAvailable && redisClient) {
      // Clear by prefix pattern (Redis doesn't support clear all directly)
      const keys = await redisClient.keys('*');
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } else {
      memoryCache.clear();
    }
    return true;
  } catch (err: any) {
    console.error('\u274c Cache clear error:', err?.message);
    return false;
  }
}

/**
 * Get cache statistics
 * @returns Cache statistics object
 */
async function getCacheStats(): Promise<{
  isRedisAvailable: boolean;
  memoryCacheSize: number;
  redisKeys?: number;
}> {
  const stats: {
    isRedisAvailable: boolean;
    memoryCacheSize: number;
    redisKeys?: number;
  } = {
    isRedisAvailable,
    memoryCacheSize: memoryCache.size
  };

  if (isRedisAvailable && redisClient) {
    try {
      stats.redisKeys = await redisClient.dbSize();
    } catch (err: any) {
      console.error('\u274c Error getting Redis stats:', err?.message);
    }
  }

  return stats;
}

/**
 * Clean up expired cache entries
 */
async function cleanupCache(): Promise<void> {
  if (!isRedisAvailable || !redisClient) return;

  try {
    // Get all keys and delete expired ones
    const keys = await redisClient.keys('*');
    const now = Date.now();
    
    for (const key of keys) {
      const ttl = await redisClient.ttl(key);
      if (ttl === -2) { // Key doesn't exist (already expired)
        await redisClient.del(key);
      }
    }
  } catch (err: any) {
    console.error('\u274c Cache cleanup error:', err?.message);
  }
}

/**
 * Clean up in-memory cache
 */
function cleanupMemoryCache(): void {
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (const [key, value] of memoryCache.entries()) {
    if (now - value.timestamp > value.ttl * 1000) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    memoryCache.delete(key);
  }

  // If still too large, delete oldest entries
  if (memoryCache.size > MAX_CACHE_SIZE) {
    const sortedKeys = [...memoryCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, memoryCache.size - MAX_CACHE_SIZE);
    
    for (const [key] of sortedKeys) {
      memoryCache.delete(key);
    }
  }
}

/**
 * Cache decorator for async functions
 * @param prefix - Cache prefix
 * @param ttl - Time to live in seconds
 * @returns Method decorator
 */
function cacheDecorator(prefix: string, ttl: number = CACHE_TTL) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function(...args: any[]) {
      const cacheKey = generateCacheKey(prefix, ...args);
      
      // Check cache first
      const cached = await getCache(cacheKey);
      if (cached !== null) {
        return cached;
      }

      // Call original function
      const result = await originalMethod.apply(this, args);

      // Cache the result
      if (result !== undefined && result !== null) {
        await setCache(cacheKey, result, ttl);
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * Ollama-specific caching functions
 */
const ollamaCache = {
  /**
   * Get cached Ollama response
   * @param messages - Messages array
   * @param model - Model name
   * @returns Cached response or null
   */
  get: async (messages: any[], model: string): Promise<any> => {
    const cacheKey = generateCacheKey(
      CACHE_PREFIXES.OLLAMA,
      model,
      JSON.stringify(messages)
    );
    return getCache(cacheKey);
  },

  /**
   * Set cached Ollama response
   * @param messages - Messages array
   * @param model - Model name
   * @param response - Response to cache
   * @returns Success status
   */
  set: async (messages: any[], model: string, response: any): Promise<boolean> => {
    const cacheKey = generateCacheKey(
      CACHE_PREFIXES.OLLAMA,
      model,
      JSON.stringify(messages)
    );
    return setCache(cacheKey, response, CACHE_TTL);
  },

  /**
   * Clear Ollama cache
   * @returns Success status
   */
  clear: async (): Promise<boolean> => {
    if (isRedisAvailable && redisClient) {
      const keys = await redisClient.keys(CACHE_PREFIXES.OLLAMA + '*');
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } else {
      for (const [key] of memoryCache.entries()) {
        if (key.startsWith(CACHE_PREFIXES.OLLAMA)) {
          memoryCache.delete(key);
        }
      }
    }
    return true;
  }
};

/**
 * File caching functions
 */
const fileCache = {
  /**
   * Get cached file content
   * @param filePath - File path
   * @returns Cached content or null
   */
  get: async (filePath: string): Promise<any> => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.FILE, filePath);
    return getCache(cacheKey);
  },

  /**
   * Set cached file content
   * @param filePath - File path
   * @param content - Content to cache
   * @returns Success status
   */
  set: async (filePath: string, content: any): Promise<boolean> => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.FILE, filePath);
    return setCache(cacheKey, content, CACHE_TTL * 10); // Longer TTL for files
  },

  /**
   * Clear file cache
   * @returns Success status
   */
  clear: async (): Promise<boolean> => {
    if (isRedisAvailable && redisClient) {
      const keys = await redisClient.keys(CACHE_PREFIXES.FILE + '*');
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } else {
      for (const [key] of memoryCache.entries()) {
        if (key.startsWith(CACHE_PREFIXES.FILE)) {
          memoryCache.delete(key);
        }
      }
    }
    return true;
  }
};

/**
 * Session caching functions
 */
const sessionCache = {
  /**
   * Get cached session
   * @param sessionId - Session ID
   * @returns Cached session or null
   */
  get: async (sessionId: string): Promise<any> => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.SESSION, sessionId);
    return getCache(cacheKey);
  },

  /**
   * Set cached session
   * @param sessionId - Session ID
   * @param sessionData - Session data to cache
   * @returns Success status
   */
  set: async (sessionId: string, sessionData: any): Promise<boolean> => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.SESSION, sessionId);
    return setCache(cacheKey, sessionData, CACHE_TTL * 60); // 5 hours for sessions
  },

  /**
   * Clear session cache
   * @returns Success status
   */
  clear: async (): Promise<boolean> => {
    if (isRedisAvailable && redisClient) {
      const keys = await redisClient.keys(CACHE_PREFIXES.SESSION + '*');
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } else {
      for (const [key] of memoryCache.entries()) {
        if (key.startsWith(CACHE_PREFIXES.SESSION)) {
          memoryCache.delete(key);
        }
      }
    }
    return true;
  }
};

export {
  initCache,
  getCache,
  setCache,
  delCache,
  clearCache,
  getCacheStats,
  cleanupCache,
  cacheDecorator,
  generateCacheKey,
  CACHE_PREFIXES,
  CACHE_TTL,
  ollamaCache,
  fileCache,
  sessionCache,
  isRedisAvailable
};
