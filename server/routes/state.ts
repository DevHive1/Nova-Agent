import express from "express";
// ============================================================
//  server/routes/state.js  —  Agent State & Logs Routes
// ============================================================


const router = express.Router();

/**
 * Save current agent run state.
 */
function saveState(ctx, hist) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ saved_at: new Date().toISOString(), context: ctx, history: hist }, null, 2));
}

/**
 * Load agent run state from file.
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return { context: d.context || "", history: d.history || [] };
    }
  } catch {}
  return { context: "", history: [] };
}

/**
 * Append entry to log file.
 */
function appendLog(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

router.get("/state", (req, res) => {
  res.json(loadState());
});

router.delete("/state", (req, res) => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch {}
  res.json({ ok: true });
});

router.get("/log", (req, res) => {
  try {
    const lines = fs.existsSync(LOG_FILE)
      ? fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-50).map(l => JSON.parse(l))
      : [];
    res.json(lines);
  } catch {
    res.json([]);
  }
});

router.get("/health", async (req, res) => {
  const { OLLAMA_URL } = require("../../shared/constants");
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    const models = d.models?.map(m => m.name) || [];
    res.json({ ok: true, ollama: true, models, ollama_url: OLLAMA_URL });
  } catch (e) {
    res.json({ ok: false, ollama: false, models: [], error: e.message, ollama_url: OLLAMA_URL });
  }
});

router.get("/models", async (req, res) => {
  const { OLLAMA_URL } = require("../../shared/constants");
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    res.json(d.models?.map(m => m.name) || []);
  } catch {
    res.json([]);
  }
});

router.get("/personas", (req, res) => {
  res.json(PERSONAS);
});

module.exports = {
  router,
  saveState,
  loadState,
  appendLog
};
export {};
export default router;
