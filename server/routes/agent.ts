import express from "express";
// ============================================================
//  server/routes/agent.js  —  Core Agent Reasoning Loop Routes
// ============================================================


const router = express.Router();

const pendingHuman = new Map();      // runId → resolve
const pendingConfirms = new Map();   // confirmId → resolve

const NEEDS_CONFIRM = new Set(["delete_file"]);

async function toolAskHuman(question, runId) {
  return new Promise(resolve => {
    pendingHuman.set(runId, resolve);
    setTimeout(() => {
      pendingHuman.delete(runId);
      resolve("(no answer — timed out)");
    }, 120000);
  });
}

async function autoplan(task, model, send) {
  send("planning", { message: "🏗 Making a plan…" });
  try {
    const raw = await askOllama([
      {
        role: "system",
        content: `You are a planning assistant. Given a coding task, produce a brief step-by-step plan.
Response format — ONLY valid JSON:
{"plan": ["step 1", "step 2", ...], "needs_files": ["file1.js"], "estimated_steps": 5}`
      },
      { role: "user", content: task }
    ], model, 60000);
    const d = JSON.parse(cleanJson(raw));
    send("plan_ready", { plan: d.plan || [], needs_files: d.needs_files || [], estimated_steps: d.estimated_steps || 5 });
    return d;
  } catch {
    return null;
  }
}

async function summarizeContext(ctx, model) {
  if (ctx.length <= MAX_CTX_CHARS) return ctx;
  try {
    const raw = await askOllama([
      {
        role: "system",
        content: "You are a context summarizer. Compress the agent conversation history into a concise plain-text summary preserving all important facts, decisions, file paths, and code changes. Return only the summary text — no JSON, no markdown."
      },
      {
        role: "user",
        content: `Summarize this agent session context:\n\n${ctx.slice(0, 20000)}`
      }
    ], model, 60000);
    // Use raw text directly — no JSON parsing needed
    const summary = raw.trim() || ctx.slice(-4000);
    return `[SUMMARIZED CONTEXT]\n${summary}`;
  } catch {
    return ctx.slice(-4000);
  }
}

function trimContext(ctx, req) {
  if (ctx.length <= MAX_CTX_CHARS) return ctx;
  return `[Original task]\n${req}\n\n[...older steps trimmed...]\n\n${ctx.slice(-4000)}`;
}

/** Trim message history to prevent token explosion — keep system + last N messages */
function trimMessages(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES + 1) return [...messages];
  const system = messages[0];
  const rest = messages.slice(1);
  return [system, ...rest.slice(-MAX_HISTORY_MESSAGES)];
}

// ── ENDPOINTS ─────────────────────────────────────────────

router.post("/human", (req, res) => {
  const { runId, answer } = req.body;
  const resolve = pendingHuman.get(runId);
  if (resolve) {
    pendingHuman.delete(runId);
    resolve(answer || "");
  }
  res.json({ ok: true });
});

router.post("/confirm", (req, res) => {
  const { runId, confirmed } = req.body;
  const resolve = pendingConfirms.get(runId);
  if (resolve) {
    pendingConfirms.delete(runId);
    resolve(confirmed);
  }
  res.json({ ok: true });
});

router.post("/run", async (req, res) => {
  const { message, model, auto_plan, workspace: activeWorkspace } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let aborted = false;
  res.on("close", () => { aborted = true; });

  const send = (type, data) => {
    if (aborted) return;
    try {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    } catch { aborted = true; }
  };

  const { context, history } = loadState();
  const activeModel = model || process.env.AGENT_MODEL || "qwen3-coder-next:cloud";
  let ctx = context;

  let userMsg = message;
  if (message.toLowerCase() === "continue" && context) {
    userMsg = "Continue the previous task from where you left off. Review the context and proceed.";
  }

  // Auto-plan if requested
  if (auto_plan && message.length > 20) {
    await autoplan(message, activeModel, send);
  }

  // Summarize context if too large
  if (ctx.length > MAX_CTX_CHARS * 1.5) {
    send("summarizing", { message: "📝 Summarizing context…" });
    ctx = await summarizeContext(ctx, activeModel);
  }

  // Inject memory if workspace is active
  let memNote = "";
  if (activeWorkspace) {
    const mem = loadMemory();
    const wMem = mem.workspaces[activeWorkspace] || {};
    const gMem = mem.global || {};
    const globalStr = Object.keys(gMem).length ? `\n[GLOBAL MEMORY]\n${Object.entries(gMem).map(([k,v])=>`${k}: ${v}`).join('\n')}` : '';
    const wsStr = Object.keys(wMem).length ? `\n[WORKSPACE MEMORY: ${activeWorkspace}]\n${Object.entries(wMem).map(([k,v])=>`${k}: ${v}`).join('\n')}` : '';
    memNote = `${globalStr}${wsStr}`;
  }

  // System Prompt details
  const persona = req.body.persona ? PERSONAS[req.body.persona] : null;
  const personaNote = persona ? `\n\n## Active Persona: ${persona.name}\n${persona.focus}` : "";
  const cwdNote = `\n\n## Current Working Directory\n${getCWD()}`;
  const memoryNote = memNote ? `\n\n## Memory Context${memNote}` : "";
  const resume = ctx ? `\n\n## Resumed Session Context\n${ctx}` : "";

  // Cap loaded history to prevent token explosion from previous sessions
  const cappedHistory = history.slice(-MAX_HISTORY_MESSAGES);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + personaNote + cwdNote + memoryNote + resume },
    ...cappedHistory,
    { role: "user", content: userMsg }
  ];

  send("start", { message: "Agent started", model: activeModel });

  const fileSnapshots = {};
  let finalAnswer = null;

  try {
    for (let n = 1; n <= MAX_STEPS; n++) {
      if (aborted) break;
      send("step", { step: n, message: `Step ${n} — Thinking…` });

      let raw;
      try {
        raw = await askOllama(messages, activeModel);
        console.log(`[Agent Loop] Step ${n} raw response:`, raw);
      } catch (e) {
        console.error(`[Agent Loop] Step ${n} Ollama error:`, e);
        send("error", { message: `Ollama error: ${e.message}` });
        break;
      }

      let data;
      try {
        const cleaned = cleanJson(raw);
        data = JSON.parse(cleaned);
        if (data.__plain__) {
          send("final", { message: data.text });
          messages.push({ role: "assistant", content: raw });
          ctx += `\n\n[Step ${n}] Final(plain): ${data.text}`;
          saveState(ctx, trimMessages(messages).slice(1));
          finalAnswer = data.text;
          break;
        }
      } catch {
        send("final", { message: raw });
        messages.push({ role: "assistant", content: raw });
        ctx += `\n\n[Step ${n}] Final(raw): ${raw.slice(0, 500)}`;
        saveState(ctx, trimMessages(messages).slice(1));
        finalAnswer = raw;
        break;
      }

      if (data.thought) {
        send("thought", { message: data.thought });
      }

      if (data.final !== undefined) {
        send("final", { message: data.final });
        messages.push({ role: "assistant", content: raw });
        ctx += `\n\n[Step ${n}] Final: ${data.final}`;
        saveState(ctx, trimMessages(messages).slice(1));
        appendLog({ step: n, type: "final", message: data.final });
        finalAnswer = data.final;
        break;
      }

      const toolName = data.tool;
      const args = data.args || {};
      if (!toolName) {
        messages.push({ role: "assistant", content: raw });
        // Trim messages in place to prevent explosion
        const trimmed = trimMessages(messages);
        messages.length = 0;
        messages.push(...trimmed);
        continue;
      }

      // reasoning tools (think, sequential_thinking)
      if (toolName === "think" || toolName === "sequential_thinking") {
        const fn = TOOLS[toolName];
        const result = fn ? String(await Promise.resolve(fn(args))) : `ERROR: unknown tool '${toolName}'`;
        
        send("thinking_step", {
          tool: toolName,
          args,
          result
        });
        
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: `[Tool result: ${toolName}]\n${result}` });
        ctx += `\n\n[Step ${n}] Tool:${toolName} Result:${result.slice(0, 500)}`;
        ctx = trimContext(ctx, userMsg);
        
        // Trim messages array to prevent context explosion
        const trimmed = trimMessages(messages);
        messages.length = 0;
        messages.push(...trimmed);
        continue;
      }

      // ask_human
      if (toolName === "ask_human") {
        const question = args.question || args.q || "Can you clarify?";
        const askRunId = `ask_${Date.now()}`;
        send("ask_human", { question, runId: askRunId });
        const answer = await toolAskHuman(question, askRunId);
        send("human_answered", { answer });
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: `[Human answered]: ${answer}` });
        ctx += `\n\n[Step ${n}] Asked: ${question}\nAnswer: ${answer}`;
        continue;
      }

      // confirm needed
      if (NEEDS_CONFIRM.has(toolName)) {
        const preview = args.path || "";
        const confirmId = `confirm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        send("confirm_request", { tool: toolName, preview, step: n, runId: confirmId });
        const confirmed = await new Promise(resolve => {
          pendingConfirms.set(confirmId, resolve);
          setTimeout(() => {
            pendingConfirms.delete(confirmId);
            resolve(false);
          }, 90000);
        });
        if (!confirmed) {
          const result = "Cancelled by user.";
          send("tool_result", { tool: toolName, result });
          messages.push({ role: "assistant", content: raw });
          messages.push({ role: "user", content: `[Tool result: ${toolName}]\n${result}` });
          ctx += `\n\n[Step ${n}] Tool:${toolName} → Cancelled`;
          continue;
        }
      }

      // file snapshot before write
      if ((toolName === "write_file" || toolName === "replace_text") && args.path) {
        const absPath = resolvePath(args.path);
        if (!fileSnapshots[absPath]) {
          try {
            fileSnapshots[absPath] = fs.readFileSync(absPath, "utf8");
          } catch {
            fileSnapshots[absPath] = "";
          }
        }
      }

      send("tool_call", { tool: toolName, args });

      // Run tool
      let result;
      if (toolName === "run_command" && args.command) {
        send("stream_start", { tool: toolName, command: args.command });
        result = await runCommandStreaming(args.command, send);
        send("stream_end", { tool: toolName });
      } else {
        const fn = TOOLS[toolName];
        result = fn ? String(await Promise.resolve(fn(args))) : `ERROR: unknown tool '${toolName}'`;
      }

      // inline diff after write
      if ((toolName === "write_file" || toolName === "replace_text") && args.path) {
        const absPath = resolvePath(args.path);
        const before = fileSnapshots[absPath] || "";
        let after = "";
        try {
          after = fs.readFileSync(absPath, "utf8");
        } catch {}
        if (before !== after) {
          send("inline_diff", { path: args.path, before, after });
        }
      }

      send("tool_result", { tool: toolName, result: result.slice(0, 1000) });
      appendLog({ step: n, tool: toolName, args, result: result.slice(0, 500) });

      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: `[Tool result: ${toolName}]\n${result}` });
      ctx += `\n\n[Step ${n}] Tool:${toolName} Result:${result.slice(0, 500)}`;
      ctx = trimContext(ctx, userMsg);

      // Trim messages array to prevent context explosion
      const trimmed = trimMessages(messages);
      messages.length = 0;
      messages.push(...trimmed);
    }
  } catch (e) {
    send("error", { message: e.message });
  }

  if (!finalAnswer) {
    send("paused", { message: `Reached ${MAX_STEPS} steps. Type 'continue' to resume.` });
    saveState(ctx, trimMessages(messages).slice(1));
  }

  res.end();
});

// ── POST /api/tool — execute a single tool directly ──────────
router.post("/tool", async (req, res) => {
  const { tool, args = {} } = req.body;
  if (!tool) return res.json({ error: "tool parameter required" });
  const fn = TOOLS[tool];
  if (!fn) return res.json({ error: `unknown tool: ${tool}` });
  try {
    const result = await fn(args);
    res.json({ ok: true, tool, result: String(result ?? "") });
  } catch (e) {
    res.json({ ok: false, tool, error: e.message });
  }
});

module.exports = router;
export {};
export default router;
