
// ============================================================
//  tests/cache.test.ts    Cache Module Tests (TypeScript)
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
} from '../server/lib/cache';

describe('Cache Module (TypeScript)', () => {
  beforeEach(async () => {
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
  });

  describe('CACHE_PREFIXES', () => {
    it('should have correct prefixes', () => {
      expect(CACHE_PREFIXES.OLLAMA).toBe('ollama:');
      expect(CACHE_PREFIXES.FILE).toBe('file:');
      expect(CACHE_PREFIXES.SESSION).toBe('session:');
    });
  });

  describe('In-memory cache', () => {
    it('should set and get values', async () => {
      const testKey = 'test:key';
      const testValue = { data: 'test' };
      
      await setCache(testKey, testValue, 60);
      const retrieved = await getCache(testKey);
      
      expect(retrieved).toEqual(testValue);
    });

    it('should delete values', async () => {
      const testKey = 'test:delete';
      await setCache(testKey, { data: 'test' });
      
      await delCache(testKey);
      const retrieved = await getCache(testKey);
      
      expect(retrieved).toBeNull();
    });
  });
});
