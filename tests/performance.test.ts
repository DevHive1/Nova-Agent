
// ============================================================
//  tests/performance.test.ts    Performance Module Tests (TypeScript)
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRequest,
  recordCacheAccess,
  recordToolCall,
  recordOllamaCall,
  getMetrics,
  resetMetrics,
  formatBytes,
  formatUptime
} from '../server/lib/performance';

describe('Performance Module (TypeScript)', () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe('recordRequest', () => {
    it('should record successful requests', () => {
      recordRequest(100);
      recordRequest(200);
      
      const metrics = getMetrics();
      expect(metrics.requests).toBe(2);
      expect(metrics.errors).toBe(0);
    });

    it('should record errors', () => {
      recordRequest(500, true);
      recordRequest(100, false);
      
      const metrics = getMetrics();
      expect(metrics.requests).toBe(2);
      expect(metrics.errors).toBe(1);
    });
  });

  describe('recordCacheAccess', () => {
    it('should record cache hits', () => {
      recordCacheAccess(true);
      recordCacheAccess(true);
      recordCacheAccess(false);
      
      const metrics = getMetrics();
      expect(metrics.cache.hits).toBe(2);
      expect(metrics.cache.misses).toBe(1);
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });
  });

  describe('formatUptime', () => {
    it('should format uptime correctly', () => {
      expect(formatUptime(0)).toBe('0s');
      expect(formatUptime(60)).toBe('1m');
      expect(formatUptime(3600)).toBe('1h');
    });
  });
});
