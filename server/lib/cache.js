// ============================================================
//  server/lib/cache.js    Redis-based Caching Layer
// ============================================================

const { createClient } = require('redis');
const { OLLAMA_URL, DEFAULT_MODEL } = require('../../shared/constants');

// Configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 300; // 5 minutes default
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE) || 10000; // Max cache entries

// Cache prefixes
const CACHE_PREFIXES = {
  OLLAMA: 'ollama:',
  FILE: 'file:',
  SESSION: 'session:',
  SWARM: 'swarm:',
  GENERIC: 'cache:'
};

// In-memory fallback cache (when Redis is not available)
const memoryCache = new Map();
let redisClient = null;
let isRedisAvailable = false;

/**
 * Initialize Redis client
 */
async function initCache() {
  try {
    redisClient = createClient({
      url: REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000) // Exponential backoff
      }
    });

    redisClient.on('error', (err) => {
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
  } catch (err) {
    console.warn('\u26a0\ufe0f Redis not available, using in-memory cache:', err.message);
    isRedisAvailable = false;
    return false;
  }
}

/**
 * Generate cache key from parameters
 * @param {string} prefix - Cache prefix
 * @param {...any} parts - Key parts to concatenate
 * @returns {string}
 */
function generateCacheKey(prefix, ...parts) {
  const keyParts = parts.map(part => {
    if (typeof part === 'object') {
      return JSON.stringify(part);
    }
    return String(part);
  });
  return prefix + keyParts.join(':');
}

/**
 * Get value from cache
 * @param {string} key - Cache key
 * @returns {Promise<any>}
 */
async function getCache(key) {
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
  } catch (err) {
    console.error('\u274c Cache get error:', err.message);
    return null;
  }
}

/**
 * Set value in cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttl - Time to live in seconds
 * @returns {Promise<boolean>}
 */
async function setCache(key, value, ttl = CACHE_TTL) {
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
  } catch (err) {
    console.error('\u274c Cache set error:', err.message);
    return false;
  }
}

/**
 * Delete value from cache
 * @param {string} key - Cache key
 * @returns {Promise<boolean>}
 */
async function delCache(key) {
  try {
    if (isRedisAvailable && redisClient) {
      await redisClient.del(key);
    } else {
      memoryCache.delete(key);
    }
    return true;
  } catch (err) {
    console.error('\u274c Cache delete error:', err.message);
    return false;
  }
}

/**
 * Clear all cache entries
 * @returns {Promise<boolean>}
 */
async function clearCache() {
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
  } catch (err) {
    console.error('\u274c Cache clear error:', err.message);
    return false;
  }
}

/**
 * Get cache statistics
 * @returns {Promise<Object>}
 */
async function getCacheStats() {
  const stats = {
    isRedisAvailable,
    memoryCacheSize: memoryCache.size,
    redisKeys: 0
  };

  if (isRedisAvailable && redisClient) {
    try {
      stats.redisKeys = await redisClient.dbsize();
    } catch (err) {
      console.error('\u274c Error getting Redis stats:', err.message);
    }
  }

  return stats;
}

/**
 * Clean up expired cache entries
 * @returns {Promise<void>}
 */
async function cleanupCache() {
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
  } catch (err) {
    console.error('\u274c Cache cleanup error:', err.message);
  }
}

/**
 * Clean up in-memory cache
 */
function cleanupMemoryCache() {
  const now = Date.now();
  const keysToDelete = [];

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
 * @param {string} prefix - Cache prefix
 * @param {number} ttl - Time to live in seconds
 * @returns {Function}
 */
function cacheDecorator(prefix, ttl = CACHE_TTL) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function(...args) {
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
   * @param {Array} messages
   * @param {string} model
   * @returns {Promise<any>}
   */
  get: async (messages, model) => {
    const cacheKey = generateCacheKey(
      CACHE_PREFIXES.OLLAMA,
      model,
      JSON.stringify(messages)
    );
    return getCache(cacheKey);
  },

  /**
   * Set cached Ollama response
   * @param {Array} messages
   * @param {string} model
   * @param {any} response
   * @returns {Promise<boolean>}
   */
  set: async (messages, model, response) => {
    const cacheKey = generateCacheKey(
      CACHE_PREFIXES.OLLAMA,
      model,
      JSON.stringify(messages)
    );
    return setCache(cacheKey, response, CACHE_TTL);
  },

  /**
   * Clear Ollama cache
   * @returns {Promise<boolean>}
   */
  clear: async () => {
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
   * @param {string} filePath
   * @returns {Promise<any>}
   */
  get: async (filePath) => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.FILE, filePath);
    return getCache(cacheKey);
  },

  /**
   * Set cached file content
   * @param {string} filePath
   * @param {any} content
   * @returns {Promise<boolean>}
   */
  set: async (filePath, content) => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.FILE, filePath);
    return setCache(cacheKey, content, CACHE_TTL * 10); // Longer TTL for files
  },

  /**
   * Clear file cache
   * @returns {Promise<boolean>}
   */
  clear: async () => {
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
   * @param {string} sessionId
   * @returns {Promise<any>}
   */
  get: async (sessionId) => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.SESSION, sessionId);
    return getCache(cacheKey);
  },

  /**
   * Set cached session
   * @param {string} sessionId
   * @param {any} sessionData
   * @returns {Promise<boolean>}
   */
  set: async (sessionId, sessionData) => {
    const cacheKey = generateCacheKey(CACHE_PREFIXES.SESSION, sessionId);
    return setCache(cacheKey, sessionData, CACHE_TTL * 60); // 5 hours for sessions
  },

  /**
   * Clear session cache
   * @returns {Promise<boolean>}
   */
  clear: async () => {
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

module.exports = {
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
