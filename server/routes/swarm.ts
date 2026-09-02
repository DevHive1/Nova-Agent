import express from "express";
// ============================================================
//  server/routes/swarm.js  —  Swarm Agent Execution Routes
// ============================================================


const router = express.Router();

// Get list of all available sub-agents
router.get("/swarm/agents", (_, res) => {
  res.json(SUB_AGENTS);
});

// Run swarm tasks and stream progress via SSE
router.post("/swarm", async (req, res) => {
  const { task, model } = req.body;
  if (!task) return res.status(400).json({ error: "No task" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type, data) => {
    try {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    } catch {}
  };

  try {
    await runOrchestrator({
      task,
      model: model || process.env.AGENT_MODEL || "qwen3-coder-next:cloud",
      onEvent: (ev) => send(ev.type, ev),
      maxRounds: 3,
    });
  } catch (e) {
    send("error", { message: e.message });
  }

  res.end();
});

module.exports = router;
export {};
export default router;
