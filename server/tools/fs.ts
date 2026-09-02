// ============================================================
//  server/tools/fs.js  —  Filesystem Tools
// ============================================================



function normPath(a) {
  return a.path || a.file_path || a.file || a.filepath || a.filename || "";
}

function normPattern(a) {
  return a.pattern || a.search || a.query || a.text || "";
}

function normDir(a) {
  return a.directory || a.dir || a.path || a.folder || ".";
}

function toolReadFile(filePath) {
  try {
    const p = resolvePath(filePath);
    const content = fs.readFileSync(p, "utf8");
    const lines = content.split("\n");
    // Return content with line numbers so the agent can use read_lines efficiently
    return lines.map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join("\n");
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolReadLines(filePath, start, end) {
  try {
    const p = resolvePath(filePath);
    const lines = fs.readFileSync(p, "utf8").split("\n");
    const total = lines.length;
    const s = Math.max(1, Number(start) || 1);
    const e = Math.min(total, Number(end) || total);
    const slice = lines.slice(s - 1, e);
    return `Lines ${s}-${e} of ${total} total:\n` +
      slice.map((l, i) => `${String(s + i).padStart(4)}: ${l}`).join("\n");
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolWriteFile(filePath, content) {
  try {
    const abs = resolvePath(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    const lines = content.split("\n").length;
    return `Saved ${abs} (${content.length} chars, ${lines} lines)`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolAppendFile(filePath, content) {
  try {
    const abs = resolvePath(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, content, "utf8");
    return `Appended to ${abs} (${content.length} chars)`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolReplaceText(filePath, old, replacement) {
  try {
    const abs = resolvePath(filePath);
    const t = fs.readFileSync(abs, "utf8");
    if (!t.includes(old)) return `ERROR: pattern not found in ${filePath}. Check for exact whitespace and quotes.`;
    fs.writeFileSync(abs, t.replace(old, replacement), "utf8");
    return `Updated ${abs}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolListFiles(dir = ".") {
  try {
    const abs = resolvePath(dir);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries.map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n") || "(empty)";
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolCreateDir(dirPath) {
  try {
    const abs = resolvePath(dirPath);
    fs.mkdirSync(abs, { recursive: true });
    return `Created: ${abs}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolDeleteFile(filePath) {
  try {
    const abs = resolvePath(filePath);
    const s = fs.statSync(abs);
    if (s.isDirectory()) {
      execSync(`rm -rf "${abs}"`);
    } else {
      fs.unlinkSync(abs);
    }
    return `Deleted: ${abs}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function toolSearchInFiles(pattern, directory = ".") {
  const results = [];
  function walk(dir) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv"].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else {
          try {
            const lines = fs.readFileSync(full, "utf8").split("\n");
            lines.forEach((line, i) => {
              if (line.toLowerCase().includes(pattern.toLowerCase())) {
                results.push(`${full}:${i + 1}: ${line.trim()}`);
              }
            });
          } catch {}
        }
      }
    } catch {}
  }
  walk(resolvePath(directory));
  return results.slice(0, 100).join("\n") || `No matches for '${pattern}'`;
}

function toolGrep(pattern, dirPath = ".") {
  try {
    const abs = resolvePath(dirPath);
    const r = execSync(
      `grep -rn --include="*.js" --include="*.ts" --include="*.py" --include="*.json" --include="*.md" --include="*.txt" --include="*.jsx" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=.git "${pattern.replace(/"/g, '\\"')}" "${abs}"`,
      { encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024 }
    );
    return r.trim() || "(no matches)";
  } catch (e) {
    // grep returns exit code 1 when no matches — not an error
    if (e.status === 1) return "(no matches)";
    return `EXIT:${e.status}\n${e.stderr || e.message}`;
  }
}

module.exports = {
  normPath,
  normPattern,
  normDir,
  readFile:       a => toolReadFile(normPath(a)),
  readLines:      a => toolReadLines(normPath(a), a.start || a.from, a.end || a.to),
  writeFile:      a => toolWriteFile(normPath(a), a.content || a.text || ""),
  appendFile:     a => toolAppendFile(normPath(a), a.content || a.text || ""),
  replaceText:    a => toolReplaceText(normPath(a), a.old || a.old_text || a.search || "", a.new || a.new_text || a.replacement || ""),
  listFiles:      a => toolListFiles(a.path || a.directory || a.dir || "."),
  createDir:      a => toolCreateDir(normPath(a) || a.directory || a.dir),
  deleteFile:     a => toolDeleteFile(normPath(a)),
  searchInFiles:  a => toolSearchInFiles(normPattern(a), normDir(a)),
  grep:           a => toolGrep(normPattern(a), a.path || a.directory || "."),
};
export {};
