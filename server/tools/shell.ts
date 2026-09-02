// ============================================================
//  server/tools/shell.js    Shell Command Execution Tools
// ============================================================


const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB max output
const MAX_EXECUTION_TIME = 60000; // 60 seconds timeout

/**
 * Sanitize command arguments to prevent injection
 * @param {string|Object} cmdOrArgs
 * @returns {string}
 */
function sanitizeCommand(cmdOrArgs) {
  if (typeof cmdOrArgs === "string") {
    return sanitizeInput(cmdOrArgs);
  }
  if (typeof cmdOrArgs === "object" && cmdOrArgs !== null) {
    const cmd = cmdOrArgs.command || cmdOrArgs.cmd || cmdOrArgs.run || "";
    return sanitizeInput(cmd);
  }
  return "";
}

/**
 * Run a command synchronously with safety checks.
 */
function toolRunCommand(cmd) {
  // Sanitize input
  const sanitizedCmd = sanitizeCommand(cmd);
  
  if (!sanitizedCmd || isDangerous(sanitizedCmd)) {
    return "BLOCKED: dangerous command pattern or invalid input.";
  }
  
  try {
    const r = execSync(sanitizedCmd, {
      encoding: "utf8",
      timeout: MAX_EXECUTION_TIME,
      maxBuffer: MAX_OUTPUT_SIZE,
      cwd: getCWD()
    });
    
    // Truncate output if too large
    const output = r.trim() || "(no output)";
    return output.slice(0, MAX_OUTPUT_SIZE);
  } catch (e) {
    const errorMsg = e.stderr || e.message || "Unknown error";
    const status = e.status || e.code || "UNKNOWN";
    return `EXIT:${status}\n${errorMsg.slice(0, 1000)}`;
  }
}

/**
 * Run a command with streaming output via SSE.
 */
function toolRunCommandStreaming(cmd, sendFn) {
  // Sanitize input
  const sanitizedCmd = sanitizeCommand(cmd);
  
  if (!sanitizedCmd || isDangerous(sanitizedCmd)) {
    return Promise.resolve("BLOCKED: dangerous command pattern or invalid input.");
  }
  
  return new Promise(resolve => {
    let out = "", err = "";
    let outputSize = 0;
    const MAX_STREAM_OUTPUT = 10 * 1024 * 1024; // 10MB max for streaming
    
    const { id, error } = bgRun(sanitizedCmd, {
      onLine: (data, isErr) => {
        if (outputSize >= MAX_STREAM_OUTPUT) {
          return; // Stop processing if output is too large
        }
        
        if (isErr) {
          err += data;
        } else {
          out += data;
        }
        outputSize += data.length;
        
        // Only send if we haven't exceeded the limit
        if (outputSize <= MAX_STREAM_OUTPUT) {
          sendFn("stream_output", { data, stderr: isErr });
        }
      },
      onDone: (code) => {
        // Truncate output if too large
        const truncatedOut = out.slice(0, MAX_OUTPUT_SIZE);
        const truncatedErr = err.slice(0, MAX_OUTPUT_SIZE);
        resolve(`EXIT:${code}\n${truncatedOut}${truncatedErr}`.trim());
      }
    });
    
    if (error) {
      resolve(`BLOCKED: dangerous command`);
    }
  });
}

/**
 * Run a command with timeout and output size limits
 * @param {string} command
 * @param {Object} options
 * @returns {Promise<string>}
 */
async function runCommandWithTimeout(command, options = {}) {
  const sanitizedCmd = sanitizeCommand(command);
  
  if (!sanitizedCmd || isDangerous(sanitizedCmd)) {
    return Promise.resolve("BLOCKED: dangerous command pattern or invalid input.");
  }
  
  const timeout = options.timeout || MAX_EXECUTION_TIME;
  
  return new Promise((resolve) => {
    const child = exec(sanitizedCmd, {
      cwd: getCWD(),
      timeout,
      maxBuffer: MAX_OUTPUT_SIZE
    });
    
    let stdout = "";
    let stderr = "";
    
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.length > MAX_OUTPUT_SIZE) {
        stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
      }
    });
    
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.length > MAX_OUTPUT_SIZE) {
        stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
      }
    });
    
    child.on("close", (code) => {
      resolve(`EXIT:${code}\n${stdout}\n${stderr}`.trim());
    });
    
    child.on("error", (err) => {
      resolve(`EXIT:ERROR\n${err.message}`);
    });
  });
}

module.exports = {
  runCommand: a => toolRunCommand(a.command || a.cmd || a.run || ""),
  runCommandStreaming: toolRunCommandStreaming,
  runCommandWithTimeout,
  MAX_OUTPUT_SIZE,
  MAX_EXECUTION_TIME
};
export {};
