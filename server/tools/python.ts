// ============================================================
//  server/tools/python.js  —  Python Code Evaluation Tool
// ============================================================


/**
 * Evaluate arbitrary Python code by writing to a temp file and executing it.
 */
function toolPythonEval(code) {
  if (!code) return "ERROR: no code provided";
  const tmpFile = `/tmp/_eval_${Date.now()}_${Math.random().toString(36).slice(2)}.py`;
  try {
    fs.writeFileSync(tmpFile, code, "utf8");
    const r = execSync(`python3 "${tmpFile}"`, {
      encoding: "utf8",
      timeout: 15000,
      cwd: getCWD()
    });
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    return r.trim() || "(no output)";
  } catch (e) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    return `ERROR: ${e.stderr || e.message}`;
  }
}

module.exports = {
  pythonEval: a => toolPythonEval(a.code || a.python || a.script || ""),
};
export {};
