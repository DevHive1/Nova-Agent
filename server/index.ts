// ============================================================
//  server/index.ts    Main Server Entry Point (TypeScript)
// ============================================================

// Load .env file when running locally (Replit uses its own Secrets panel)
try { require("dotenv").config(); } catch {}

import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import http from "http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";

// Initialize cache and performance monitoring
import { initCache, getCacheStats } from "./lib/cache";
import { startPerformanceMonitoring, performanceMiddleware, getMetrics } from "./lib/performance";

// Import routers
import stateRouter from "./routes/state";
import workspaceRouter from "./routes/workspace";
import filesRouter from "./routes/files";
import { UPLOAD_DIR } from "./routes/files";;
import agentRouter from "./routes/agent";
import swarmRouter from "./routes/swarm";
import processesRouter from "./routes/processes";
import { initTerminal } from "./routes/terminal";;
import { SCREENSHOT_DIR } from "./tools/screenshot";

const app: Express = express();
const PORT: number = parseInt(process.env.PORT || "3131");

//  SECURITY CONFIGURATION 
// Configure allowed origins for CORS
const ALLOWED_ORIGINS: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5000", "http://localhost:3131", "http://127.0.0.1:5000", "http://127.0.0.1:3131"];

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: "Too many requests from this IP, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

//  MIDDLEWARES 
// Security headers
app.use(helmet());

// CORS with specific origins
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Rate limiting
app.use(limiter);

// Request compression
app.use(compression());

// Body parser with size limit
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Performance monitoring middleware
app.use(performanceMiddleware());

//  STATIC SERVERS 
app.use("/.screenshots", express.static(SCREENSHOT_DIR));
app.use("/.uploads", express.static(UPLOAD_DIR));

//  ROUTES 
app.use("/api", stateRouter);
app.use("/api", workspaceRouter);
app.use("/api", filesRouter);
app.use("/api", agentRouter);
app.use("/api", swarmRouter);
app.use("/api", processesRouter);

// Webhook routes (must be before catch-all routes)
import { router as webhooksRouter } from "./routes/webhooks";
app.use("/", webhooksRouter as any);

//  HEALTH CHECK ENDPOINT 
app.get("/health", async (req: Request, res: Response) => {
  const cacheStats = await getCacheStats();
  const perfStats = getMetrics();
  
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "1.0.0",
    services: {
      ollama: process.env.OLLAMA_URL || "http://localhost:11434",
      server: `http://localhost:${PORT}`,
      redis: process.env.REDIS_URL || "redis://localhost:6379"
    },
    cache: cacheStats,
    performance: {
      requests: perfStats.requests,
      avgResponseTime: perfStats.avgResponseTime,
      memoryUsage: perfStats.memoryUsage,
      cpuUsage: perfStats.cpuUsage
    }
  });
});

//  PERFORMANCE METRICS ENDPOINT 
app.get("/api/metrics", (req: Request, res: Response) => {
  res.json(getMetrics());
});

//  CACHE MANAGEMENT ENDPOINTS 
app.get("/api/cache/stats", async (req: Request, res: Response) => {
  const stats = await getCacheStats();
  res.json(stats);
});

app.post("/api/cache/clear", async (req: Request, res: Response) => {
  const { clearCache } = require("./lib/cache");
  const cleared = await clearCache();
  res.json({ ok: cleared });
});

//  ERROR HANDLING MIDDLEWARE 
// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Server Error:", err.message, err.stack);
  res.status(500).json({
    error: process.env.NODE_ENV === "development" ? err.message : "Internal Server Error",
    path: req.path,
  });
});

//  START SERVER 
async function startServer(): Promise<void> {
  // Initialize cache
  const cacheInitialized = await initCache();
  if (cacheInitialized) {
    console.log("\u2705 Redis cache initialized");
  } else {
    console.log("\u26a0\ufe0f Using in-memory cache (Redis not available)");
  }
  
  // Start performance monitoring
  startPerformanceMonitoring();
  
  // Create HTTP server
  const httpServer = http.createServer(app);

  // Initialize WebSocket Terminal Server
  initTerminal(httpServer);

  // Start Server
  httpServer.listen(PORT, () => {
    console.log(`\n  \u2699\ufe0f Agent server running at http://localhost:${PORT}`);
    console.log(`  \ud83d\udda5  Terminal WS at ws://localhost:${PORT}/terminal`);
    console.log(`  \u2705 Cache: ${cacheInitialized ? 'Redis' : 'In-memory'}`);
    console.log(`  \u2705 Performance monitoring: Active\n`);
  });
}

// Start the server
startServer();

export default app;
