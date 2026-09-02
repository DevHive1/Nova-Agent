// ============================================================
//  server/routes/terminal.js  —  WebSocket Terminal (PTY / Spawn fallback)
// ============================================================


const terminals = new Map(); // terminalId → {pty/proc, ws}
let nodePty = null;
try {
  nodePty = require("node-pty");
} catch {}

/**
 * Initialize the WebSocket Server on top of the existing httpServer.
 * @param {import("http").Server} httpServer
 */
function initTerminal(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/terminal" });

  wss.on("connection", (ws, req) => {
    const id = Date.now().toString();
    const shell = process.env.SHELL || "/bin/bash";
    const currentCwd = getCWD();

    if (nodePty) {
      // Full PTY for a rich shell experience
      const pty = nodePty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd: currentCwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
      pty.onData(data => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "output", data }));
      });
      pty.onExit(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "exit" }));
        terminals.delete(id);
      });
      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "input")  pty.write(msg.data);
          if (msg.type === "resize") pty.resize(msg.cols, msg.rows);
          if (msg.type === "cwd")    { try { process.chdir(msg.cwd); } catch {} }
        } catch {}
      });
      ws.on("close", () => {
        try { pty.kill(); } catch {}
        terminals.delete(id);
      });
      terminals.set(id, { pty, ws });
    } else {
      // Fallback: line-by-line using child_process spawn
      const proc = spawn(shell, [], { cwd: currentCwd, env: process.env });
      proc.stdout.on("data", d => ws.readyState === 1 && ws.send(JSON.stringify({ type: "output", data: d.toString() })));
      proc.stderr.on("data", d => ws.readyState === 1 && ws.send(JSON.stringify({ type: "output", data: d.toString() })));
      proc.on("exit", () => {
        ws.readyState === 1 && ws.send(JSON.stringify({ type: "exit" }));
        terminals.delete(id);
      });
      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "input") proc.stdin.write(msg.data);
        } catch {}
      });
      ws.on("close", () => {
        try { proc.kill(); } catch {}
        terminals.delete(id);
      });
      terminals.set(id, { proc, ws });
    }

    ws.send(JSON.stringify({ type: "ready", id, hasPty: !!nodePty, cwd: currentCwd }));
  });
}

module.exports = { initTerminal, terminals };
export {};
export { initTerminal };
