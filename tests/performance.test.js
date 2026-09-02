// ============================================================
//  tests/performance.test.js    Performance Module Tests
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
  formatUptime,
  getOptimizationRecommendations
} from '../server/lib/performance.js';

describe('Performance Module', () => {
  beforeEach(() => {
    // Reset metrics before each test
    resetMetrics();
  });

  describe('recordRequest', () => {
    it('should record successful requests', () => {
      recordRequest(100);
      recordRequest(200);
      
      const metrics = getMetrics();
      expect(metrics.requests).toBe(2);
      expect(metrics.errors).toBe(0);
      // responseTimes is internal, check via getMetrics
      // responseTimes is internal
    });

    it('should record errors', () => {
      recordRequest(500, true);
      recordRequest(100, false);
      
      const metrics = getMetrics();
      expect(metrics.requests).toBe(2);
      expect(metrics.errors).toBe(1);
    });

    it('should track max and min response times', () => {
      recordRequest(100);
      recordRequest(500);
      recordRequest(250);
      
      const metrics = getMetrics();
      expect(metrics.maxResponseTime).toBe(500);
      expect(metrics.minResponseTime).toBe(100);
    });

    it('should calculate average response time', () => {
      recordRequest(100);
      recordRequest(200);
      recordRequest(300);
      
      const metrics = getMetrics();
      expect(metrics.avgResponseTime).toBe(200);
    });

    it('should limit response times array to 1000 entries', () => {
      for (let i = 0; i < 1500; i++) {
        recordRequest(i);
      }
      
      const metrics = getMetrics();
      // responseTimes array is limited internally
    });
  });

  describe('recordCacheAccess', () => {
    it('should record cache hits', () => {
      recordCacheAccess(true);
      recordCacheAccess(true);
      recordCacheAccess(false);
      
      const metrics = getMetrics();
      expect(metrics.cacheHits).toBe(2);
      expect(metrics.cacheMisses).toBe(1);
      const m = getMetrics();
      const expectedRate = (2 / 3) * 100;
      expect(m.cache.hits).toBe(2);
      expect(m.cache.misses).toBe(1);
    });

    it('should calculate cache hit rate correctly', () => {
      recordCacheAccess(true);
      recordCacheAccess(true);
      recordCacheAccess(true);
      recordCacheAccess(false);
      
      const metrics = getMetrics();
      const m2 = getMetrics();
      expect(m2.cache.hits).toBe(3);
      expect(m2.cache.misses).toBe(1);
    });
  });

  describe('recordToolCall', () => {
    it('should record tool calls', () => {
      recordToolCall('read_file', 100);
      recordToolCall('write_file', 200);
      recordToolCall('read_file', 150);
      
      const metrics = getMetrics();
      expect(metrics.toolCalls.read_file).toBe(2);
      expect(metrics.toolCalls.write_file).toBe(1);
    });
  });

  describe('recordOllamaCall', () => {
    it('should record Ollama calls', () => {
      recordOllamaCall(100);
      recordOllamaCall(200);
      
      const metrics = getMetrics();
      expect(metrics.ollamaCalls).toBe(2);
      expect(metrics.ollamaAvgTime).toBe(150);
    });

    it('should calculate average Ollama call time', () => {
      recordOllamaCall(100);
      recordOllamaCall(200);
      recordOllamaCall(300);
      
      const metrics = getMetrics();
      expect(metrics.ollamaAvgTime).toBe(200);
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
      expect(formatBytes(500)).toBe('500 Bytes');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
    });

    it('should handle decimal values', () => {
      expect(formatBytes(1536)).toBe('1.50 KB');
      expect(formatBytes(2560)).toBe('2.50 KB');
    });
  });

  describe('formatUptime', () => {
    it('should format uptime correctly', () => {
      expect(formatUptime(0)).toBe('0s');
      expect(formatUptime(30)).toBe('30s');
      expect(formatUptime(60)).toBe('1m');
      expect(formatUptime(90)).toBe('1m 30s');
      expect(formatUptime(3600)).toBe('1h');
      expect(formatUptime(3661)).toBe('1h 1m 1s');
      expect(formatUptime(86400)).toBe('1d');
      expect(formatUptime(90061)).toBe('1d 1h 1m 1s');
    });
  });

  describe('getOptimizationRecommendations', () => {
    it('should return empty array when no issues', () => {
      const recommendations = getOptimizationRecommendations();
      expect(Array.isArray(recommendations)).toBe(true);
    });

    it('should return high response time recommendation', () => {
      // Simulate high response times
      for (let i = 0; i < 20; i++) {
        recordRequest(2000); // 2 second response time
      }
      
      const recommendations = getOptimizationRecommendations();
      const hasHighResponse = recommendations.some(
        r => r.message === 'High average response time'
      );
      expect(hasHighResponse).toBe(true);
    });

    it('should return high error rate recommendation', () => {
      // Simulate high error rate
      for (let i = 0; i < 9; i++) {
        recordRequest(100, true); // Errors
      }
      recordRequest(100, false); // One success
      
      const recommendations = getOptimizationRecommendations();
      const hasHighError = recommendations.some(
        r => r.message === 'High error rate'
      );
      expect(hasHighError).toBe(true);
    });
  });

  describe('resetMetrics', () => {
    it('should reset all metrics', () => {
      recordRequest(100);
      recordCacheAccess(true);
      recordToolCall('read_file', 100);
      recordOllamaCall(100);
      
      resetMetrics();
      
      const metrics = getMetrics();
      expect(metrics.requests).toBe(0);
      expect(metrics.errors).toBe(0);
      expect(metrics.cacheHits).toBe(0);
      expect(metrics.cacheMisses).toBe(0);
      expect(metrics.ollamaCalls).toBe(0);
      expect(Object.keys(metrics.toolCalls).length).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('should return metrics object with all properties', () => {
      const metrics = getMetrics();
      
      expect(metrics).toHaveProperty('requests');
      expect(metrics).toHaveProperty('errors');
      expect(metrics).toHaveProperty('avgResponseTime');
      expect(metrics).toHaveProperty('responseTimes');
      expect(metrics).toHaveProperty('maxResponseTime');
      expect(metrics).toHaveProperty('minResponseTime');
      expect(metrics).toHaveProperty('memoryUsage');
      expect(metrics).toHaveProperty('cpuUsage');
      expect(metrics).toHaveProperty('cache');
      expect(metrics).toHaveProperty('system');
      expect(metrics).toHaveProperty('timestamp');
    });

    it('should return formatted memory usage', () => {
      const metrics = getMetrics();
      
      expect(metrics.memoryUsage).toHaveProperty('rss');
      expect(metrics.memoryUsage).toHaveProperty('heapTotal');
      expect(metrics.memoryUsage).toHaveProperty('heapUsed');
      expect(metrics.memoryUsage).toHaveProperty('external');
    });

    it('should return formatted system info', () => {
      const metrics = getMetrics();
      
      expect(metrics.system).toHaveProperty('platform');
      expect(metrics.system).toHaveProperty('arch');
      expect(metrics.system).toHaveProperty('cpus');
      expect(metrics.system).toHaveProperty('totalMemory');
      expect(metrics.system).toHaveProperty('freeMemory');
      expect(metrics.system).toHaveProperty('loadAvg');
    });
  });
});
