// ============================================================
//  server/tools/extra.js  —  Extended Agent Tools
//  find_files · zip · diff_files · lint
// ============================================================


// ─── find_files ────────────────────────────────────────────────
function toolFindFiles(args) {
  const pattern  = args.pattern || args.name || args.glob || "";
  const dir      = args.directory || args.path || args.dir || ".";
  const ext      = args.ext || args.extension || "";
  const maxdepth = parseInt(args.maxdepth || args.depth || 8, 10);
  const type     = args.type || "f";   // f=files, d=dirs, any=both

  const absDir = resolvePath(dir);
  const IGNORE = ["*/node_modules/*", "*/.git/*", "*/dist/*", "*/__pycache__/*", "*/.venv/*"];
  const ignoreArgs = IGNORE.flatMap(p => ["-not", "-path", p]);

  const cmd = ["find", absDir, "-maxdepth", String(maxdepth), ...ignoreArgs];

  if (type === "f") cmd.push("-type", "f");
  if (type === "d") cmd.push("-type", "d");

  if (ext) {
    cmd.push("-name", `*.${ext.replace(/^\./, "")}`);
  } else if (pattern) {
    cmd.push("-name", `*${pattern}*`);
  }

  try {
    const r = spawnSync("find", cmd.slice(1), {
      encoding: "utf8", timeout: 15000, cwd: getCWD()
    });
    const out = (r.stdout || "").trim();
    if (!out) return `No files found matching '${pattern || ext || "*"}' in ${dir}`;
    const lines = out.split("\n").slice(0, 100);
    const relative = lines.map(l => path.relative(getCWD(), l) || l);
    const summary = `Found ${lines.length} item(s):\n\n${relative.join("\n")}`;
    return summary + (lines.length === 100 ? "\n...[first 100 shown]" : "");
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ─── zip ───────────────────────────────────────────────────────
function toolZip(args) {
  const action = (args.action || args.mode || "create").toLowerCase();
  const archive = args.file || args.archive || args.zip;
  const source  = args.source || args.path || args.dir || ".";
  const dest    = args.dest || args.output || ".";

  if (!archive) return "ERROR: 'file' parameter required (archive name, e.g. 'output.zip')";

  const absArchive = resolvePath(archive);
  const absSource  = resolvePath(source);

  const isTar = archive.endsWith(".tar.gz") || archive.endsWith(".tgz") || archive.endsWith(".tar");

  try {
    if (action === "create" || action === "zip" || action === "compress") {
      let cmd;
      if (isTar) {
        const srcBase = path.basename(absSource);
        const srcDir  = path.dirname(absSource);
        cmd = `tar -czf "${absArchive}" -C "${srcDir}" "${srcBase}"`;
      } else {
        const srcBase = path.basename(absSource);
        const srcDir  = path.dirname(absSource);
        cmd = `cd "${srcDir}" && zip -r "${absArchive}" "${srcBase}"`;
      }
      execSync(cmd, { timeout: 30000, cwd: getCWD(), stdio: "pipe" });
      const stat = fs.statSync(absArchive);
      return `✅ Created: ${archive} (${(stat.size / 1024).toFixed(1)} KB)\nSource: ${source}`;

    } else if (action === "extract" || action === "unzip" || action === "decompress") {
      const absDest = resolvePath(dest);
      fs.mkdirSync(absDest, { recursive: true });
      let cmd;
      if (isTar) {
        cmd = `tar -xzf "${absArchive}" -C "${absDest}"`;
      } else {
        cmd = `unzip -o "${absArchive}" -d "${absDest}"`;
      }
      const out = execSync(cmd, { timeout: 30000, cwd: getCWD(), encoding: "utf8" });
      return `✅ Extracted: ${archive} → ${dest}\n${out.slice(0, 800)}`;

    } else if (action === "list" || action === "ls" || action === "contents") {
      let cmd;
      if (isTar) {
        cmd = `tar -tzf "${absArchive}"`;
      } else {
        cmd = `unzip -l "${absArchive}"`;
      }
      const out = execSync(cmd, { timeout: 10000, encoding: "utf8" });
      return `Contents of ${archive}:\n${out.slice(0, 3000)}`;

    }
    return `ERROR: unknown action '${action}'. Use: create | extract | list`;
  } catch (e) {
    if (e.stderr) return `ERROR: ${e.stderr.toString().slice(0, 500)}`;
    return `ERROR: ${e.message}`;
  }
}

// ─── diff_files ────────────────────────────────────────────────
function toolDiffFiles(args) {
  const file1 = args.file1 || args.a || args.old || args.before;
  const file2 = args.file2 || args.b || args.new || args.after;
  if (!file1 || !file2) {
    return `ERROR: two parameters required — file1 and file2 (or a/b, old/new)`;
  }

  const abs1 = resolvePath(file1);
  const abs2 = resolvePath(file2);

  if (!fs.existsSync(abs1)) return `ERROR: file1 not found: ${file1}`;
  if (!fs.existsSync(abs2)) return `ERROR: file2 not found: ${file2}`;

  const r = spawnSync("diff", ["-u", "--label", file1, "--label", file2, abs1, abs2], {
    encoding: "utf8", timeout: 10000
  });

  if (r.status === 0) return `Files are identical:\n  ${file1}\n  ${file2}`;

  const output = r.stdout || "";
  const lines   = output.split("\n");
  const added   = lines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = lines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;

  return (
    `--- ${file1}  →  ${file2}\n` +
    `+${added} lines added,  -${removed} lines removed\n\n` +
    output.slice(0, 5000) +
    (output.length > 5000 ? "\n...[truncated]" : "")
  );
}

// ─── lint ──────────────────────────────────────────────────────
function toolLint(args) {
  const target = args.file || args.path || args.target || ".";
  const hint   = (args.linter || args.type || "auto").toLowerCase();

  const absTarget = resolvePath(target);
  const ext       = path.extname(target).toLowerCase();

  const isJS  = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext);
  const isPY  = ext === ".py";
  const isJSON = ext === ".json";
  const isSH  = ext === ".sh" || ext === ".bash";

  const cwd = getCWD();

  try {
    // ── JavaScript / TypeScript ──────────────────────────────
    if (hint === "eslint" || (hint === "auto" && isJS)) {
      const localEslint = path.join(cwd, "node_modules", ".bin", "eslint");
      const eslintBin   = fs.existsSync(localEslint) ? `"${localEslint}"` : "npx eslint";
      try {
        const out = execSync(
          `${eslintBin} "${absTarget}" --format=compact --max-warnings=100 2>&1`,
          { encoding: "utf8", timeout: 30000, cwd }
        );
        return out.trim() || "✅ No ESLint issues found";
      } catch (e) {
        const out = (e.stdout || "") + (e.stderr || "");
        return out.trim() || `ESLint exit ${e.status}`;
      }
    }

    // ── Python ───────────────────────────────────────────────
    if (hint === "flake8" || hint === "python" || (hint === "auto" && isPY)) {
      try {
        const out = execSync(
          `python3 -m flake8 "${absTarget}" --max-line-length=120 2>&1`,
          { encoding: "utf8", timeout: 20000, cwd }
        );
        return out.trim() || "✅ No flake8 issues found";
      } catch (e) {
        const flakeOut = (e.stdout || e.stderr || "").trim();
        if (flakeOut) return `Flake8 issues:\n${flakeOut}`;
        // fallback: syntax check only
        const syn = execSync(`python3 -m py_compile "${absTarget}" && echo "Syntax OK"`, {
          encoding: "utf8", timeout: 10000, cwd, stdio: "pipe"
        });
        return syn.trim() || "Syntax OK";
      }
    }

    // ── JSON ─────────────────────────────────────────────────
    if (hint === "json" || (hint === "auto" && isJSON)) {
      try {
        JSON.parse(fs.readFileSync(absTarget, "utf8"));
        return "✅ Valid JSON";
      } catch (e) {
        return `❌ Invalid JSON: ${e.message}`;
      }
    }

    // ── Shell ─────────────────────────────────────────────────
    if (hint === "sh" || hint === "bash" || (hint === "auto" && isSH)) {
      const out = execSync(`bash -n "${absTarget}" 2>&1 && echo "Syntax OK"`, {
        encoding: "utf8", timeout: 10000, cwd
      });
      return out.trim() || "✅ Shell syntax OK";
    }

    // ── Generic directory / fallback ──────────────────────────
    if (hint === "auto") {
      return `Cannot auto-detect linter for '${ext || target}'. Specify: linter=eslint|flake8|json|sh`;
    }

    return `ERROR: unknown linter '${hint}'. Use: eslint | flake8 | json | sh`;
  } catch (e) {
    const out = (e.stdout || e.stderr || "").trim();
    return out || `ERROR: ${e.message}`;
  }
}

module.exports = {
  findFiles: a => toolFindFiles(a),
  zip:       a => toolZip(a),
  diffFiles: a => toolDiffFiles(a),
  lint:      a => toolLint(a),
};
export {};
