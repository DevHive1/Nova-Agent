import path from "path";
// ============================================================
//  server/lib/safety.js    Dangerous command detection
// ============================================================


/**
 * Additional dangerous patterns for enhanced security
 */
const ADDITIONAL_DANGEROUS = [
  // File system operations
  /rm\s+-rf/,
  /rm\s+-r/,
  /chmod\s+777/,
  /chmod\s+-R/,
  /dd\s+if=/,
  /mkfs/,
  /format\s+/,
  
  // System operations
  /reboot/,
  /shutdown/,
  /halt/,
  /poweroff/,
  
  // Package managers (potentially destructive)
  /npm\s+install\s+-g/,
  /pip\s+install\s+--upgrade/,
  /apt-get\s+remove/,
  /yum\s+remove/,
  
  // Process management
  /kill\s+-9/,
  /pkill/,
  /killall/,
  
  // Network operations
  /nc\s+-l/,
  /netcat\s+-l/,
  /sshd/,
  /telnetd/,
  
  // Code injection patterns
  /;\s*\w+/,
  /\|\|\s*\w+/,
  /&&\s*\w+/,
  /`\s*\w+/,
  /\$\s*\(/,
  /\{\s*\|/,
];

/**
 * Returns true if the command matches any dangerous pattern.
 * @param {string} cmd
 * @returns {boolean}
 */
function isDangerous(cmd) {
  if (!cmd || typeof cmd !== "string") return true;
  
  // Check against all dangerous patterns
  const allPatterns = [...DANGEROUS, ...ADDITIONAL_DANGEROUS];
  return allPatterns.some(p => p.test(cmd));
}

/**
 * Sanitize input to prevent command injection
 * @param {string} input
 * @returns {string}
 */
function sanitizeInput(input) {
  if (!input || typeof input !== "string") return "";
  
  // Remove potentially dangerous characters
  return input
    .replace(/[;&|`$<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate file path to prevent directory traversal
 * @param {string} filePath
 * @param {string} baseDir
 * @returns {boolean}
 */
function isValidPath(filePath, baseDir) {
  if (!filePath || typeof filePath !== "string") return false;
  
  // Resolve the path and check if it's within the base directory
  const resolvedPath = require("path").resolve(filePath);
  const resolvedBase = require("path").resolve(baseDir || process.cwd());
  
  return resolvedPath.startsWith(resolvedBase);
}

module.exports = { 
  isDangerous, 
  DANGEROUS,
  ADDITIONAL_DANGEROUS,
  sanitizeInput,
  isValidPath 
};
export {};
