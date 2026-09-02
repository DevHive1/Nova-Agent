// ============================================================
//  server/lib/processManager.js  —  Process Manager for Spawned Actions
// ============================================================


const bgProcesses = new Map();   // id → { id, cmd, proc, output, startedAt, status }
let bgIdCounter   = 0;
const pmListeners = new Set();   // SSE response objects for /api/processes/stream

/**
 * Broadcast an event to all process manager SSE listeners.
 */
function pmBroadcast(type, data) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of pmListeners) {
    try {
      res.write(msg);
    } catch {
      pmListeners.delete(res);
    }
  }
}

/**
 * Return a snapshot of all active and inactive processes.
 */
function pmSnapshot() {
  return [...bgProcesses.values()].map(p => ({
    id: p.id,
    cmd: p.cmd,
    status: p.status,
    startedAt: p.startedAt,
    exitCode: p.exitCode,
    output: p.output.slice(-3000),
    pid: p.proc?.pid,
  }));
}

/**
 * Run a command in the background.
 */
function bgRun(cmd, { onLine, onDone } = {}) {
  if (isDangerous(cmd)) {
    return { error: "BLOCKED" };
  }

  const id = ++bgIdCounter;
  const entry = {
    id,
    cmd,
    status: "running",
    startedAt: new Date().toISOString(),
    output: "",
    exitCode: null,
    proc: null,
  };
  bgProcesses.set(id, entry);
  pmBroadcast("process_start", { process: { ...entry, output: "" } });

  const proc = spawn("sh", ["-c", cmd], { cwd: getCWD(), env: process.env });
  entry.proc = proc;

  const append = (data, isErr = false) => {
    entry.output += data;
    if (entry.output.length > 50000) {
      entry.output = entry.output.slice(-40000);
    }
    pmBroadcast("process_output", { id, data, isErr });
    if (onLine) onLine(data, isErr);
  };

  proc.stdout.on("data", d => append(d.toString()));
  proc.stderr.on("data", d => append(d.toString(), true));
  proc.on("close", code => {
    entry.status = code === 0 ? "done" : "error";
    entry.exitCode = code;
    entry.proc = null;
    pmBroadcast("process_end", { id, exitCode: code, status: entry.status });
    if (onDone) onDone(code, entry.output);
    
    // keep last 50 processes
    if (bgProcesses.size > 50) {
      const oldest = [...bgProcesses.entries()].find(([, v]) => v.status !== "running");
      if (oldest) bgProcesses.delete(oldest[0]);
    }
  });
  proc.on("error", e => {
    entry.status = "error";
    append(`ERROR: ${e.message}`, true);
    pmBroadcast("process_end", { id, exitCode: -1, status: "error" });
    if (onDone) onDone(-1, entry.output);
  });

  return { id, proc };
}

/**
 * Kill a specific background process.
 */
function killProcess(id) {
  const p = bgProcesses.get(id);
  if (!p) return false;
  if (p.proc) {
    try {
      p.proc.kill("SIGTERM");
    } catch {}
    p.status = "killed";
  }
  return true;
}

/**
 * Kill all running background processes.
 */
function killAllProcesses() {
  for (const [, p] of bgProcesses) {
    if (p.proc) {
      try {
        p.proc.kill();
      } catch {}
    }
  }
  bgProcesses.clear();
}

module.exports = {
  bgProcesses,
  pmListeners,
  pmBroadcast,
  pmSnapshot,
  bgRun,
  killProcess,
  killAllProcesses
};
export {};
