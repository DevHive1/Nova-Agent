import path from "path";

// ============================================================
//  server/lib/cwd.js  —  Active Current Working Directory (CWD) state
// ============================================================


let CWD = process.cwd();

/**
 * Get the current active working directory of the agent.
 * @returns {string}
 */
function getCWD() {
  return CWD;
}

/**
 * Set the current active working directory of the agent.
 * @param {string} newCwd
 */
function setCWD(newCwd) {
  CWD = newCwd;
}

/**
 * Resolve a path relative to the current active working directory.
 * If the path is absolute, it returns the path as-is.
 * @param {string} p
 * @returns {string}
 */
function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(CWD, p);
}

module.exports = { getCWD, setCWD, resolvePath };
export {};
