import express from "express";
// ============================================================
//  server/routes/processes.js  —  Process Manager Routes
// ============================================================


const router = express.Router();

// Get list of all background processes
router.get("/processes", (_, res) => {
  res.json(pmSnapshot());
});

// Kill a specific background process
router.delete("/processes/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const success = killProcess(id);
  if (!success) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ ok: true });
});

// Kill all processes
router.delete("/processes", (_, res) => {
  killAllProcesses();
  res.json({ ok: true });
});

// Stream process outputs and lifecycle updates using SSE
router.get("/processes/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  
  // send current snapshot immediately
  res.write(`data: ${JSON.stringify({ type: "snapshot", processes: pmSnapshot() })}\n\n`);
  
  pmListeners.add(res);
  res.on("close", () => {
    pmListeners.delete(res);
  });
});

module.exports = router;
export {};
export default router;
