import express from "express";
// ============================================================
//  server/routes/files.js  —  File system explorer, screenshots, and uploads
// ============================================================


const router = express.Router();

// ── UPLOAD CONFIG ──────────────────────────────────────────
const UPLOAD_DIR = path.join(process.cwd(), ".uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Helper to build the file tree recursively
function buildTree(dir, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return [];
  const IGNORE = new Set([
    '.git', 'node_modules', '.next', 'dist', 'build', 
    '__pycache__', '.DS_Store', '.venv', 'venv', '.cache', 
    '.agent_state.json', '.agent_log.jsonl'
  ]);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
      .map(e => {
        const fp = path.join(dir, e.name);
        const isDir = e.isDirectory();
        return {
          name: e.name,
          path: fp,
          type: isDir ? 'dir' : 'file',
          ext: isDir ? null : path.extname(e.name).slice(1),
          children: isDir ? buildTree(fp, depth + 1, maxDepth) : undefined
        };
      });
  } catch {
    return [];
  }
}

// File Tree
router.get("/tree", (_, res) => {
  try {
    const cwd = getCWD();
    res.json({ cwd, tree: buildTree(cwd) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read File
router.get("/file", (req, res) => {
  try {
    const fp = resolvePath(req.query.path);
    const content = fs.readFileSync(fp, "utf8");
    const stat = fs.statSync(fp);
    res.json({ path: fp, content, size: stat.size, mtime: stat.mtime });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Write File
router.post("/file", (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    const abs = resolvePath(filePath);
    let original = "";
    try {
      original = fs.readFileSync(abs, "utf8");
    } catch {}
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    res.json({ ok: true, path: abs, original });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Screenshots
router.get("/screenshot", (req, res) => {
  const { file } = req.query;
  if (!file) return res.status(400).json({ error: "No file" });
  const abs = path.isAbsolute(file) ? file : path.join(SCREENSHOT_DIR, file);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: "Not found" });
  res.sendFile(abs);
});

router.post("/screenshot", async (req, res) => {
  const { url, fullPage, wait, width, height } = req.body;
  if (!url) return res.status(400).json({ error: "No url" });
  const result = await screenshot({
    url,
    full_page: fullPage,
    wait,
    width,
    height
  });
  if (result.startsWith("ERROR")) {
    return res.status(500).json({ error: result });
  }
  const filePath = result.match(/SCREENSHOT:(.+)/)?.[1]?.trim();
  res.json({ ok: true, path: filePath, url: `/.screenshots/${path.basename(filePath)}` });
});

// Uploads
router.post("/upload", express.raw({ type: "image/*", limit: "20mb" }), (req, res) => {
  try {
    // Validate file size
    if (req.headers["content-length"] && parseInt(req.headers["content-length"]) > 20 * 1024 * 1024) {
      return res.status(413).json({ error: "File too large. Maximum 20MB allowed." });
    }
    
    const ext = (req.headers["content-type"] || "image/png").split("/")[1]?.split(";")[0] || "png";
    const name = `upload_${Date.now()}.${ext}`;
    const dest = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(dest, req.body);
    res.json({ ok: true, path: dest, url: `/.uploads/${name}`, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/upload/base64", express.json({ limit: "20mb" }), (req, res) => {
  try {
    const { data, ext = "png", name: reqName } = req.body;
    if (!data) return res.status(400).json({ error: "No data" });
    
    // Validate base64 data
    if (typeof data !== "string") {
      return res.status(400).json({ error: "Data must be a base64 string" });
    }
    
    // Check data size before processing
    const base64Data = data.replace(/^data:[^;]+;base64,/, "");
    if (base64Data.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: "File too large. Maximum 20MB allowed." });
    }
    
    const buf = Buffer.from(base64Data, "base64");
    const name = reqName || `upload_${Date.now()}.${ext}`;
    const dest = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(dest, buf);
    res.json({ ok: true, path: dest, url: `/.uploads/${name}`, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = {
  router,
  UPLOAD_DIR
};
export {};
export default router;
export { UPLOAD_DIR };
