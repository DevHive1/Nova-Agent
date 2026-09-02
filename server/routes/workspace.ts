import express from "express";
// ============================================================
//  server/routes/workspace.js  —  Workspace and Memory management routes
// ============================================================


const router = express.Router();

// ── MEMORY HELPERS ────────────────────────────────────────
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    }
  } catch {}
  return { workspaces: {}, global: {} };
}

function saveMemory(m) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(m, null, 2));
}

// ── TASK HISTORY HELPERS ──────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
  } catch {}
  return [];
}

function appendHistory(task) {
  const hist = loadHistory();
  hist.unshift({ ...task, id: Date.now(), timestamp: new Date().toISOString() });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist.slice(0, 200), null, 2));
}

// ── WORKSPACES HELPERS ────────────────────────────────────
function loadWorkspaces() {
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf8"));
    }
  } catch {}
  return [{ id: "default", name: "Default", cwd: getCWD(), createdAt: new Date().toISOString() }];
}

function saveWorkspaces(ws) {
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(ws, null, 2));
}

function toolCd(dir) {
  try {
    const abs = resolvePath(dir);
    if (!fs.existsSync(abs)) return `ERROR: directory not found: ${abs}`;
    if (!fs.statSync(abs).isDirectory()) return `ERROR: not a directory: ${abs}`;
    setCWD(abs);
    return `CWD changed to: ${getCWD()}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ── ENDPOINTS ─────────────────────────────────────────────

// Memory
router.get("/memory", (req, res) => res.json(loadMemory()));

router.post("/memory", (req, res) => {
  const mem = loadMemory();
  const { workspace, key, value } = req.body;
  if (workspace) {
    if (!mem.workspaces[workspace]) mem.workspaces[workspace] = {};
    mem.workspaces[workspace][key] = value;
  } else {
    mem.global[key] = value;
  }
  saveMemory(mem);
  res.json({ ok: true });
});

router.delete("/memory", (req, res) => {
  const { workspace, key } = req.body || {};
  const mem = loadMemory();
  if (workspace && key) {
    delete mem.workspaces?.[workspace]?.[key];
  } else if (workspace) {
    delete mem.workspaces[workspace];
  } else if (key) {
    delete mem.global[key];
  } else {
    mem.global = {};
    mem.workspaces = {};
  }
  saveMemory(mem);
  res.json({ ok: true });
});

// History
router.get("/history", (req, res) => res.json(loadHistory()));

router.post("/history", (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "No data" });
    }
    appendHistory(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/history", (req, res) => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      fs.unlinkSync(HISTORY_FILE);
    }
  } catch {}
  res.json({ ok: true });
});

// Workspaces
router.get("/workspaces", (req, res) => res.json(loadWorkspaces()));

router.post("/workspaces", (req, res) => {
  const ws = loadWorkspaces();
  const w = {
    id: Date.now().toString(),
    name: req.body.name || "Workspace",
    cwd: req.body.cwd || getCWD(),
    createdAt: new Date().toISOString()
  };
  ws.push(w);
  saveWorkspaces(ws);
  res.json(w);
});

router.delete("/workspaces/:id", (req, res) => {
  const ws = loadWorkspaces().filter(w => w.id !== req.params.id);
  saveWorkspaces(ws);
  res.json({ ok: true });
});

router.post("/workspaces/:id/activate", (req, res) => {
  const ws = loadWorkspaces().find(w => w.id === req.params.id);
  if (!ws) return res.status(404).json({ error: "Not found" });
  const result = toolCd(ws.cwd);
  res.json({ ok: true, cwd: getCWD(), message: result });
});

// CWD
router.get("/cwd", (_, res) => res.json({ cwd: getCWD() }));

router.post("/cwd", (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: "No dir" });
  const result = toolCd(dir);
  if (result.startsWith("ERROR")) return res.status(400).json({ error: result });
  res.json({ cwd: getCWD(), message: result });
});

module.exports = {
  router,
  loadMemory,
  appendHistory
};
export {};
export default router;
