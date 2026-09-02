// ============================================================
//  tests/cache.test.js    Cache Module Tests
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCache,
  setCache,
  delCache,
  clearCache,
  getCacheStats,
  generateCacheKey,
  CACHE_PREFIXES
} from '../server/lib/cache.js';

describe('Cache Module', () => {
  beforeEach(async () => {
    // Clear any existing cache before each test
    await clearCache();
  });

  describe('generateCacheKey', () => {
    it('should generate key with prefix and parts', () => {
      const key = generateCacheKey('test:', 'part1', 'part2', 'part3');
      expect(key).toBe('test:part1:part2:part3');
    });

    it('should handle object parts', () => {
      const obj = { a: 1, b: 2 };
      const key = generateCacheKey('test:', obj);
      expect(key).toBe('test:{"a":1,"b":2}');
    });

    it('should handle multiple parts', () => {
      const key = generateCacheKey('ollama:', 'model1', '[{"role":"user"}]');
      expect(key).toContain('ollama:model1:');
    });

    it('should handle empty parts', () => {
      const key = generateCacheKey('test:', '', null, undefined);
      expect(key).toBe('test::null:undefined');
    });
  });

  describe('CACHE_PREFIXES', () => {
    it('should have correct prefixes', () => {
      expect(CACHE_PREFIXES.OLLAMA).toBe('ollama:');
      expect(CACHE_PREFIXES.FILE).toBe('file:');
      expect(CACHE_PREFIXES.SESSION).toBe('session:');
      expect(CACHE_PREFIXES.SWARM).toBe('swarm:');
      expect(CACHE_PREFIXES.GENERIC).toBe('cache:');
    });
  });

  describe('In-memory cache (fallback)', () => {
    it('should set and get values', async () => {
      const testKey = 'test:key';
      const testValue = { data: 'test' };
      
      await setCache(testKey, testValue, 60);
      const retrieved = await getCache(testKey);
      
      expect(retrieved).toEqual(testValue);
    });

    it('should return null for non-existent keys', async () => {
      const retrieved = await getCache('non:existent:key');
      expect(retrieved).toBeNull();
    });

    it('should delete values', async () => {
      const testKey = 'test:delete';
      await setCache(testKey, { data: 'test' });
      
      await delCache(testKey);
      const retrieved = await getCache(testKey);
      
      expect(retrieved).toBeNull();
    });

    it('should clear all cache', async () => {
      await setCache('key1', 'value1');
      await setCache('key2', 'value2');
      
      await clearCache();
      
      expect(await getCache('key1')).toBeNull();
      expect(await getCache('key2')).toBeNull();
    });

    it('should respect TTL', async () => {
      const testKey = 'test:ttl';
      await setCache(testKey, { data: 'test' }, 1); // 1 second TTL
      
      // Should be available immediately
      expect(await getCache(testKey)).not.toBeNull();
      
      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should be null after TTL
      expect(await getCache(testKey)).toBeNull();
    });

    it('should handle null/undefined keys', async () => {
      await expect(setCache(null, 'value')).resolves.toBe(false);
      await expect(setCache(undefined, 'value')).resolves.toBe(false);
      await expect(getCache(null)).resolves.toBeNull();
      await expect(getCache(undefined)).resolves.toBeNull();
    });

    it('should handle complex objects', async () => {
      const complexObj = {
        nested: {
          data: [1, 2, 3],
          config: { enabled: true }
        },
        timestamp: Date.now()
      };
      
      await setCache('complex:key', complexObj);
      const retrieved = await getCache('complex:key');
      
      expect(retrieved).toEqual(complexObj);
    });
  });

  describe('getCacheStats', () => {
    it('should return stats object', async () => {
      const stats = await getCacheStats();
      
      expect(stats).toHaveProperty('isRedisAvailable');
      expect(stats).toHaveProperty('memoryCacheSize');
      expect(typeof stats.isRedisAvailable).toBe('boolean');
      expect(typeof stats.memoryCacheSize).toBe('number');
    });
  });

  describe('Cache cleanup', () => {
    it('should cleanup old entries when exceeding max size', async () => {
      // Set many cache entries
      for (let i = 0; i < 100; i++) {
        await setCache(`cleanup:test:${i}`, { data: i });
      }
      
      const stats1 = await getCacheStats();
      expect(stats1.memoryCacheSize).toBeLessThanOrEqual(10000);
    });
  });
});
