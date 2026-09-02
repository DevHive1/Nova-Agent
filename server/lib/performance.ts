// ============================================================
import os from "os";
//  server/lib/performance.ts    Performance Monitoring and Optimization (TypeScript)
// ============================================================


// Performance metrics storage
interface Metrics {
  uptime: number;
  requests: number;
  errors: number;
  avgResponseTime: number;
  responseTimes: number[];
  maxResponseTime: number;
  minResponseTime: number;
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  activeConnections: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  ollamaCalls: number;
  ollamaAvgTime: number;
  toolCalls: Record<string, number>;
  lastReset: number;
}

const metrics: Metrics = {
  uptime: 0,
  requests: 0,
  errors: 0,
  avgResponseTime: 0,
  responseTimes: [],
  maxResponseTime: 0,
  minResponseTime: Infinity,
  memoryUsage: process.memoryUsage(),
  cpuUsage: process.cpuUsage(),
  activeConnections: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheHitRate: 0,
  ollamaCalls: 0,
  ollamaAvgTime: 0,
  toolCalls: {},
  lastReset: Date.now()
};

// Performance observer for async operations
const perfObserver = new PerformanceObserver((list) => {
  const entry = list.getEntries()[0];
  
  if (entry && entry.name) {
    // Track tool call performance
    if (entry.name.startsWith('tool:')) {
      const toolName = entry.name.slice(5);
      metrics.toolCalls[toolName] = (metrics.toolCalls[toolName] || 0) + 1;
    }
    
    // Track Ollama calls
    if (entry.name === 'ollama:call') {
      metrics.ollamaCalls++;
      metrics.ollamaAvgTime = (
        (metrics.ollamaAvgTime * (metrics.ollamaCalls - 1)) + entry.duration
      ) / metrics.ollamaCalls;
    }
  }
});

perfObserver.observe({ entryTypes: ['measure'] });

/**
 * Start performance monitoring
 */
function startPerformanceMonitoring(): void {
  // Update memory and CPU usage every 5 seconds
  setInterval(() => {
    metrics.memoryUsage = process.memoryUsage();
    metrics.cpuUsage = process.cpuUsage();
    metrics.uptime = process.uptime();
    
    // Calculate cache hit rate
    const totalCache = metrics.cacheHits + metrics.cacheMisses;
    metrics.cacheHitRate = totalCache > 0 ? (metrics.cacheHits / totalCache) * 100 : 0;
    
    // Log performance summary every minute
    if (Date.now() - metrics.lastReset >= 60000) {
      logPerformanceSummary();
      metrics.lastReset = Date.now();
    }
  }, 5000);
  
  console.log('\u26a0\ufe0f  Performance monitoring started');
}

/**
 * Record request performance
 * @param responseTime - Response time in ms
 * @param isError - Whether the request resulted in an error
 */
function recordRequest(responseTime: number, isError: boolean = false): void {
  metrics.requests++;
  
  if (isError) {
    metrics.errors++;
  }
  
  metrics.responseTimes.push(responseTime);
  
  if (responseTime > metrics.maxResponseTime) {
    metrics.maxResponseTime = responseTime;
  }
  
  if (responseTime < metrics.minResponseTime) {
    metrics.minResponseTime = responseTime;
  }
  
  // Keep only last 1000 response times to prevent memory issues
  if (metrics.responseTimes.length > 1000) {
    metrics.responseTimes.shift();
  }
  
  // Recalculate average
  const sum = metrics.responseTimes.reduce((a, b) => a + b, 0);
  metrics.avgResponseTime = sum / metrics.responseTimes.length;
}

/**
 * Record cache hit/miss
 * @param isHit - Whether it was a cache hit
 */
function recordCacheAccess(isHit: boolean): void {
  if (isHit) {
    metrics.cacheHits++;
  } else {
    metrics.cacheMisses++;
  }
}

/**
 * Record tool call performance
 * @param toolName - Name of the tool
 */
function recordToolCall(toolName: string): void {
  metrics.toolCalls[toolName] = (metrics.toolCalls[toolName] || 0) + 1;
}

/**
 * Record Ollama call performance
 * @param duration - Duration in ms
 */
function recordOllamaCall(duration: number): void {
  metrics.ollamaCalls++;
  metrics.ollamaAvgTime = (
    (metrics.ollamaAvgTime * (metrics.ollamaCalls - 1)) + duration
  ) / metrics.ollamaCalls;
}

/**
 * Get current performance metrics
 * @returns Formatted metrics object
 */
function getMetrics(): any {
  return {
    ...metrics,
    // Format memory usage
    memoryUsage: {
      rss: formatBytes(metrics.memoryUsage.rss),
      heapTotal: formatBytes(metrics.memoryUsage.heapTotal),
      heapUsed: formatBytes(metrics.memoryUsage.heapUsed),
      external: formatBytes(metrics.memoryUsage.external),
      raw: metrics.memoryUsage
    },
    // Format CPU usage
    cpuUsage: {
      user: formatBytes(metrics.cpuUsage.user),
      system: formatBytes(metrics.cpuUsage.system),
      raw: metrics.cpuUsage
    },
    // Format uptime
    uptime: formatUptime(metrics.uptime),
    uptimeSeconds: metrics.uptime,
    // Format response times
    responseTimes: {
      avg: metrics.avgResponseTime.toFixed(2) + 'ms',
      max: metrics.maxResponseTime + 'ms',
      min: metrics.minResponseTime === Infinity ? '0ms' : metrics.minResponseTime + 'ms',
      count: metrics.responseTimes.length
    },
    // Format cache stats
    cache: {
      hits: metrics.cacheHits,
      misses: metrics.cacheMisses,
      hitRate: metrics.cacheHitRate.toFixed(2) + '%',
      usingRedis: isRedisAvailable
    },
    // Format system info
    system: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: formatBytes(os.totalmem()),
      freeMemory: formatBytes(os.freemem()),
      loadAvg: os.loadavg()
    },
    // Format tool calls
    toolCalls: metrics.toolCalls,
    // Timestamp
    timestamp: new Date().toISOString()
  };
}

/**
 * Get performance metrics as JSON
 * @returns JSON string
 */
function getMetricsJSON(): string {
  return JSON.stringify(getMetrics(), null, 2);
}

/**
 * Log performance summary to console
 */
function logPerformanceSummary(): void {
  const m = getMetrics();
  
  console.log('\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log('  \u26a1 PERFORMANCE SUMMARY');
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  console.log(`  Requests: ${m.requests} (${m.errors} errors)`);
  console.log(`  Avg Response: ${m.responseTimes.avg}`);
  console.log(`  Cache Hit Rate: ${m.cache.hitRate}`);
  console.log(`  Memory: ${m.memoryUsage.heapUsed} (RSS: ${m.memoryUsage.rss})`);
  console.log(`  Ollama Calls: ${m.ollamaCalls} (Avg: ${m.ollamaAvgTime.toFixed(2)}ms)`);
  console.log(`  Uptime: ${m.uptime}`);
  console.log('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
}

/**
 * Reset all metrics
 */
function resetMetrics(): void {
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.avgResponseTime = 0;
  metrics.responseTimes = [];
  metrics.maxResponseTime = 0;
  metrics.minResponseTime = Infinity;
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.ollamaCalls = 0;
  metrics.ollamaAvgTime = 0;
  metrics.toolCalls = {};
  metrics.lastReset = Date.now();
}

/**
 * Measure execution time of a function
 * @param name - Name of the measurement
 * @param fn - Function to measure
 * @returns Return value of the function
 */
async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  const duration = end - start;
  
  // Record in performance observer
  performance.measure(name, { start, end });
  
  return result;
}

/**
 * Measure sync function execution time
 * @param name - Name of the measurement
 * @param fn - Function to measure
 * @returns Return value of the function
 */
function measureSync<T>(name: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const end = performance.now();
  const duration = end - start;
  
  // Record in performance observer
  performance.measure(name, { start, end });
  
  return result;
}

/**
 * Format bytes to human readable format
 * @param bytes - Bytes to format
 * @returns Formatted string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  const value = bytes / Math.pow(k, i);
  const formatted = value % 1 === 0 
    ? value.toFixed(0) + ' ' + sizes[i]
    : value.toFixed(2) + ' ' + sizes[i];
  return formatted;
}

/**
 * Format uptime to human readable format
 * @param seconds - Uptime in seconds
 * @returns Formatted string
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}

/**
 * Check if system is under heavy load
 * @returns True if system is overloaded
 */
function isSystemOverloaded(): boolean {
  const loadAvg = os.loadavg();
  const cpus = os.cpus().length;
  
  // System is overloaded if 1-minute load average > number of CPUs
  return loadAvg[0] > cpus * 0.8;
}

/**
 * Check if memory usage is too high
 * @returns True if memory usage is high
 */
function isMemoryHigh(): boolean {
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  
  // Memory is high if heap used > 80% of total memory
  return (memoryUsage.heapUsed / totalMemory) > 0.8;
}

/**
 * Optimization recommendation
 */
interface Recommendation {
  type: 'error' | 'warning' | 'info';
  message: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Get optimization recommendations
 * @returns Array of recommendations
 */
function getOptimizationRecommendations(): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const m = getMetrics();
  
  // Check if response times are high
  if (m.avgResponseTime > 1000) {
    recommendations.push({
      type: 'warning',
      message: 'High average response time',
      description: `Average response time is ${m.avgResponseTime}ms. Consider adding caching or optimizing queries.`,
      severity: 'high'
    });
  }
  
  // Check if error rate is high
  if (m.requests > 0 && (m.errors / m.requests) > 0.1) {
    recommendations.push({
      type: 'error',
      message: 'High error rate',
      description: `Error rate is ${((m.errors / m.requests) * 100).toFixed(2)}%. Investigate and fix errors.`,
      severity: 'critical'
    });
  }
  
  // Check if cache hit rate is low
  if (m.cache.hitRate < 30 && m.cache.hits + m.cache.misses > 10) {
    recommendations.push({
      type: 'info',
      message: 'Low cache hit rate',
      description: `Cache hit rate is ${m.cache.hitRate}. Consider increasing cache TTL or adding more cacheable endpoints.`,
      severity: 'medium'
    });
  }
  
  // Check if memory usage is high
  if (isMemoryHigh()) {
    recommendations.push({
      type: 'warning',
      message: 'High memory usage',
      description: `Memory usage is ${m.memoryUsage.heapUsed}. Consider optimizing memory usage or adding more memory.`,
      severity: 'high'
    });
  }
  
  // Check if system is overloaded
  if (isSystemOverloaded()) {
    recommendations.push({
      type: 'error',
      message: 'System overloaded',
      description: 'System load average is high. Consider scaling horizontally or optimizing resource usage.',
      severity: 'critical'
    });
  }
  
  // Check if Redis is not available
  if (!isRedisAvailable) {
    recommendations.push({
      type: 'info',
      message: 'Redis not available',
      description: 'Using in-memory cache instead of Redis. For production, consider setting up Redis for better performance.',
      severity: 'low'
    });
  }
  
  return recommendations;
}

/**
 * Create performance middleware for Express
 * @returns Express middleware function
 */
function performanceMiddleware(): (req: any, res: any, next: () => void) => void {
  return function(req: any, res: any, next: () => void) {
    const start = performance.now();
    metrics.activeConnections++;
    
    res.on('finish', () => {
      const duration = performance.now() - start;
      metrics.activeConnections--;
      
      const isError = res.statusCode >= 400;
      recordRequest(duration, isError);
    });
    
    res.on('close', () => {
      metrics.activeConnections--;
    });
    
    next();
  };
}

export {
  startPerformanceMonitoring,
  recordRequest,
  recordCacheAccess,
  recordToolCall,
  recordOllamaCall,
  getMetrics,
  getMetricsJSON,
  logPerformanceSummary,
  resetMetrics,
  measure,
  measureSync,
  formatBytes,
  formatUptime,
  isSystemOverloaded,
  isMemoryHigh,
  getOptimizationRecommendations,
  performanceMiddleware,
  metrics
};
