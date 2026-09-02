// ============================================================
//  server/index.js    Main Server Entry Point
// ============================================================

// Load .env file when running locally (Replit uses its own Secrets panel)
try { require("dotenv").config(); } catch {}

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");

const { router: stateRouter } = require("./routes/state");
const { router: workspaceRouter } = require("./routes/workspace");
const { router: filesRouter, UPLOAD_DIR } = require("./routes/files");
const agentRouter = require("./routes/agent");
const swarmRouter = require("./routes/swarm");
const processesRouter = require("./routes/processes");
const { initTerminal } = require("./routes/terminal");
const { SCREENSHOT_DIR } = require("./tools/screenshot");

const app = express();
const PORT = parseInt(process.env.PORT) || 3131;

//  SECURITY CONFIGURATION 
// Configure allowed origins for CORS
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
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

//  MIDDLEWARES 
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

//  STATIC SERVERS 
app.use("/.screenshots", express.static(SCREENSHOT_DIR));
app.use("/.uploads", express.static(UPLOAD_DIR));

//  ROUTES 
app.use("/api", stateRouter);
app.use("/api", workspaceRouter);
app.use("/api", filesRouter);
app.use("/api", agentRouter);
app.use("/api", swarmRouter);
app.use("/api", processesRouter);

//  HEALTH CHECK ENDPOINT 
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "1.0.0",
    services: {
      ollama: process.env.OLLAMA_URL || "http://localhost:11434",
      server: `http://localhost:${PORT}`,
    },
  });
});

//  ERROR HANDLING MIDDLEWARE 
// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Server Error:", err.message, err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "development" ? err.message : "Internal Server Error",
    path: req.path,
  });
});

// Create HTTP server
const httpServer = http.createServer(app);

// Initialize WebSocket Terminal Server
initTerminal(httpServer);

// Start Server
httpServer.listen(PORT, () => {
  console.log(`\n  \u2699\ufe0f Agent server running at http://localhost:${PORT}`);
  console.log(`  \ud83d\udda5  Terminal WS at ws://localhost:${PORT}/terminal\n`);
});

module.exports = app;
