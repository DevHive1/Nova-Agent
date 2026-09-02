#!/usr/bin/env node
// ============================================================
//  telegram/bot.js    Telegram Agent Bot
//  Connects to agent_server.js (port 3131)
// ============================================================

// Load .env for local development (Replit uses its own Secrets panel)
try { require("dotenv").config(); } catch {}

const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

//  CONFIG 
const TOKEN = process.env.TELEGRAM_TOKEN;
const SERVER_URL = process.env.AGENT_SERVER || "http://localhost:3131";
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map(s => s.trim())
  : [];  // empty = allow everyone

if (!TOKEN) {
  console.error("\u274c  Set TELEGRAM_TOKEN environment variable");
  console.error("    export TELEGRAM_TOKEN=your_token_here");
  process.exit(1);
}

//  BOT INIT 
const bot = new TelegramBot(TOKEN, { polling: true });

//  STATE MANAGEMENT WITH CLEANUP 
const sessions = new Map();  // chatId  { model, persona, running, abortCtrl, lastActivity }
const SESSION_TIMEOUT = 3600000; // 1 hour in ms - cleanup inactive sessions

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { 
      model: null, 
      persona: "coder", 
      running: false, 
      autoPlan: false, 
      voiceReply: false, 
      lastInputType: "text",
      lastActivity: Date.now()
    });
  }
  
  // Update last activity time
  const session = sessions.get(chatId);
  session.lastActivity = Date.now();
  return session;
}

// Cleanup inactive sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  const inactiveSessions = [];
  
  for (const [chatId, session] of sessions.entries()) {
    if (!session.running && (now - session.lastActivity) > SESSION_TIMEOUT) {
      inactiveSessions.push(chatId);
    }
  }
  
  for (const chatId of inactiveSessions) {
    sessions.delete(chatId);
    console.log(`\u26a0\ufe0f  Cleaned up inactive session: ${chatId}`);
  }
  
  if (inactiveSessions.length > 0) {
    console.log(`\u26a0\ufe0f  Session cleanup: removed ${inactiveSessions.length} inactive sessions`);
  }
}, 15 * 60 * 1000); // Run every 15 minutes

//  AUTH 
function isAllowed(msg) {
  if (ALLOWED_USERS.length === 0) return true;
  const username = msg.from?.username || "";
  const userId = String(msg.from?.id || "");
  return ALLOWED_USERS.includes(username) || ALLOWED_USERS.includes(userId);
}

//  SERVER API HELPERS WITH ERROR HANDLING 
const API_TIMEOUT = 30000; // 30 seconds timeout

async function apiGet(path, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await _apiRequest("GET", path, null);
      return result;
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(`\u26a0\ufe0f  API GET attempt ${attempt}/${retries} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function apiPost(path, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await _apiRequest("POST", path, body);
      return result;
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(`\u26a0\ufe0f  API POST attempt ${attempt}/${retries} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function _apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER_URL + path);
    const lib = url.protocol === "https:" ? https : http;
    
    const options = {
      method: method,
      headers: {},
    };
    
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));
    }
    
    const req = lib.request(url.href, options, res => {
      let data = "";
      
      res.on("data", chunk => {
        data += chunk;
        // Prevent memory issues with very large responses
        if (data.length > 10 * 1024 * 1024) { // 10MB limit
          res.destroy();
          reject(new Error("Response too large"));
        }
      });
      
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(data);
        }
      });
      
      res.on("error", reject);
    });
    
    req.on("error", reject);
    req.setTimeout(API_TIMEOUT, () => {
      req.destroy();
      reject(new Error(`API timeout after ${API_TIMEOUT}ms`));
    });
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

//  SSE STREAMING RUNNER WITH ERROR HANDLING 
async function runAgent(chatId, message, model, persona, msgId) {
  const session = getSession(chatId);
  
  if (session.running) {
    try {
      await bot.sendMessage(chatId, "\u23f3 Agent is already running. Send /stop to cancel.");
    } catch (e) {
      console.error("Error sending message:", e.message);
    }
    return;
  }

  session.running = true;
  const url = new URL(SERVER_URL + "/api/run");
  const body = JSON.stringify({ message, model, persona, auto_plan: session.autoPlan });
  const lib = url.protocol === "https:" ? https : http;

  //  Live status message 
  let statusMsgId = null;
  let statusText = "";
  let lastEditAt = 0;
  const EDIT_INTERVAL = 1500; // ms between edits

  async function setStatus(text) {
    statusText = text;
    const now = Date.now();
    if (now - lastEditAt < EDIT_INTERVAL) return; // throttle
    lastEditAt = now;
    try {
      if (!statusMsgId) {
        const m = await bot.sendMessage(chatId, text, { 
          parse_mode: "HTML", 
          disable_web_page_preview: true 
        });
        statusMsgId = m.message_id;
      } else {
        await bot.editMessageText(text, { 
          chat_id: chatId, 
          message_id: statusMsgId, 
          parse_mode: "HTML", 
          disable_web_page_preview: true 
        });
      }
    } catch (e) {
      console.error("Error updating status:", e.message);
    }
  }

  async function deleteStatus() {
    if (!statusMsgId) return;
    try { 
      await bot.deleteMessage(chatId, statusMsgId); 
    } catch (e) {
      console.error("Error deleting status:", e.message);
    }
    statusMsgId = null;
  }

  async function sendMsg(text, opts = {}) {
    const chunks = chunkText(text, 4000);
    for (const chunk of chunks) {
      try {
        await bot.sendMessage(chatId, chunk, { 
          parse_mode: "HTML", 
          disable_web_page_preview: true, 
          ...opts 
        });
      } catch {
        try { 
          await bot.sendMessage(chatId, chunk, { disable_web_page_preview: true }); 
        } catch (e) {
          console.error("Error sending message chunk:", e.message);
        }
      }
    }
  }

  //  State 
  let stepCount = 0;
  let finalAnswer = null;
  let currentThought = "";
  let streamBuf = "";
  let streamTimer = null;
  let planShown = false;

  // Step tracker: array of {tool, args, result, thought}
  const steps = [];
  let curStep = null;

  function buildStatusText() {
    const bar = "\u25b0".repeat(Math.min(stepCount, 10)) + "\u25b1".repeat(Math.max(0, 10 - stepCount));
    let lines = ["\ud83e\udd16 <b>Agent Running</b>  <code>" + bar + "</code>  step " + stepCount];
    if (currentThought) lines.push("\n\ud83d\udcad <i>" + escHtml(currentThought.slice(0, 120)) + (currentThought.length > 120 ? "\u2026" : "") + "</i>");
    if (curStep?.tool) {
      lines.push("\n\u2699\ufe0f <b>" + escHtml(curStep.tool) + "</b>");
      const argStr = formatArgs(curStep.args);
      if (argStr) lines.push("<code>" + escHtml(argStr) + "</code>");
    }
    if (steps.length > 1) {
      const recent = steps.slice(-3).map(s =>
        "  " + toolEmoji(s.tool) + " " + escHtml(s.tool) + (s.ok ? "  \u2713" : "  \u2717")
      ).join("\n");
      lines.push("\n<b>Recent:</b>\n" + recent);
    }
    return lines.join("\n");
  }

  return new Promise(resolve => {
    const req = lib.request(url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let buf = "";

      res.on("data", chunk => {
        buf += chunk.toString();
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          try { 
            handleEvent(JSON.parse(line.slice(5).trim()));
          } catch (e) {
            console.error("Error parsing SSE event:", e.message);
          }
        }
      });

      res.on("end", async () => {
        session.running = false;
        clearTimeout(streamTimer);
        await deleteStatus();
        if (finalAnswer) {
          await sendFinalMessage(chatId, finalAnswer, stepCount, steps);
        } else {
          await sendMsg("\u26a0\ufe0f <b>Session ended</b>\n\nNo final answer. Send <b>continue</b> to resume.");
        }
        resolve();
      });

      res.on("error", async e => {
        session.running = false;
        clearTimeout(streamTimer);
        await deleteStatus();
        await sendMsg(`\u274c <b>Connection error:</b> ${escHtml(e.message)}`);
        resolve();
      });
    });

    req.on("error", async e => {
      session.running = false;
      clearTimeout(streamTimer);
      try { 
        await deleteStatus(); 
        await sendMsg(`\u274c <b>Server error:</b> ${escHtml(e.message)}`); 
      } catch {}
      resolve();
    });

    req.write(body);
    req.end();
    session.abortReq = req;

    //  EVENT HANDLER 
    async function handleEvent(ev) {
      try {
        switch (ev.type) {
          case "step":
            stepCount++;
            curStep = { tool: null, args: {}, result: null };
            await setStatus(buildStatusText());
            break;

          case "thought":
            currentThought = ev.message || "";
            await setStatus(buildStatusText());
            break;

          case "thinking_step": {
            const tool = ev.tool;
            const args = ev.args || {};
            const result = ev.result || "";
            const thoughtText = args.thought || args.reasoning || "";
            const thoughtNumber = args.thoughtNumber || args.thought_number || 1;
            const totalThoughts = args.totalThoughts || args.total_thoughts || 1;

            steps.push({ tool, args, result, ok: true });

            let header = "\ud83e\udde0 <b>Planning\u2026</b>";
            if (tool === "sequential_thinking") {
              header = "\ud83e\udde0 <b>Thinking (" + thoughtNumber + "/" + totalThoughts + ")</b>";
            }

            let text = header + "\n\n";
            if (thoughtText) {
              text += "\ud83d\udcad <i>" + escHtml(thoughtText) + "</i>\n\n";
            }
            text += "<code>" + escHtml(result) + "</code>";

            await sendMsg(text);
            await setStatus(buildStatusText());
            break;
          }

          case "tool_call":
            curStep = { tool: ev.tool, args: ev.args || {}, result: null, ok: false };
            await setStatus(buildStatusText());
            break;

          case "tool_result": {
            if (curStep) { 
              curStep.result = ev.result; 
              curStep.ok = !ev.result?.startsWith("ERROR"); 
            }
            const tool = ev.tool || curStep?.tool || "tool";
            const result = ev.result || "";
            const args = curStep?.args || {};

            // Push to steps history
            steps.push({ tool, args, result, ok: !result.startsWith("ERROR") });

            // Send rich result card
            await sendToolCard(tool, args, result);

            curStep = null;
            await setStatus(buildStatusText());
            break;
          }

          case "stream_start":
            streamBuf = "";
            await setStatus("\u25b6\ufe0f <b>Running:</b> <code>" + escHtml(ev.command || "") + "</code>\n\n<i>Streaming output\u2026</i>");
            break;

          case "stream_output":
            streamBuf += ev.data || "";
            clearTimeout(streamTimer);
            streamTimer = setTimeout(async () => {
              const lines = streamBuf.trim().split("\n").slice(-15);
              await setStatus(
                "\u25b6\ufe0f <b>Terminal output:</b>\n<pre>" + escHtml(lines.join("\n").slice(0, 600)) + "</pre>"
              );
            }, 500);
            break;

          case "stream_end": {
            clearTimeout(streamTimer);
            const outLines = streamBuf.trim().split("\n").slice(-20).join("\n");
            if (outLines.trim()) {
              await sendMsg("\ud83d\udcbb <b>Command output:</b>\n<pre>" + escHtml(outLines.slice(0, 3000)) + "</pre>");
            }
            streamBuf = "";
            break;
          }

          case "planning":
            await setStatus("\ud83c\udfd7 <b>Making a plan\u2026</b>\n<i>Analyzing task\u2026</i>");
            break;

          case "plan_ready":
            if (ev.plan?.length && !planShown) {
              planShown = true;
              const planLines = ev.plan.map((s, i) => (i + 1) + ". " + s).join("\n");
              await sendMsg("\ud83d\udccb <b>Plan ready</b>\n\n" + escHtml(planLines));
            }
            break;

          case "summarizing":
            await setStatus("\ud83d\udcdd <b>Summarizing context\u2026</b>\n<i>Context too large, compressing\u2026</i>");
            break;

          case "inline_diff": {
            const diff = buildRichDiff(ev.before || "", ev.after || "");
            if (diff) {
              await sendMsg(
                "\ud83d\udcdd <b>File changed:</b> <code>" + escHtml(ev.path) + "</code>\n\n<pre>" + escHtml(diff) + "</pre>"
              );
            }
            break;
          }

          case "ask_human": {
            session.pendingAsk = { runId: ev.runId, question: ev.question };
            await deleteStatus();
            statusMsgId = null;
            await sendMsg(
              "\u2753 <b>Agent needs your input:</b>\n\n" + escHtml(ev.question) + "\n\n<i>Reply with your answer, or send /skip</i>",
              {
                reply_markup: {
                  inline_keyboard: [[
                    { text: "\u23ed Skip", callback_data: "human_skip_" + ev.runId }
                  ]]
                }
              }
            );
            break;
          }

          case "human_answered":
            await sendMsg("\u2705 <b>Answer sent to agent</b>");
            break;

          case "confirm_request":
            await deleteStatus();
            statusMsgId = null;
            await sendMsg(
              "\u26a0\ufe0f <b>Confirm action:</b>\n\n" +
              "Tool: <code>" + escHtml(ev.tool) + "</code>\n" +
              "<pre>" + escHtml(ev.preview || "") + "</pre>",
              {
                reply_markup: {
                  inline_keyboard: [[
                    { text: "\u2714 Run it", callback_data: "confirm_yes_" + ev.runId },
                    { text: "\u2718 Cancel", callback_data: "confirm_no_" + ev.runId }
                  ]]
                }
              }
            );
            break;

          case "final":
            finalAnswer = ev.message;
            break;

          case "paused":
            await deleteStatus();
            await sendMsg("\u23f8 <b>Agent paused</b> after " + stepCount + " steps.\n\nSend <b>continue</b> to resume.");
            break;

          case "error":
            await deleteStatus();
            await sendMsg("\u274c <b>Error:</b> " + escHtml(ev.message || "Unknown error"));
            break;
        }
      } catch (e) {
        console.error("Error in event handler:", e.message);
      }
    }

    //  TOOL RESULT CARD 
    async function sendToolCard(tool, args, result) {
      const emoji = toolEmoji(tool);
      const isErr = result?.startsWith("ERROR");
      const header = emoji + " <b>" + escHtml(tool) + "</b>" + (isErr ? " \u274c" : " \u2705");

      switch (tool) {
        case "read_file": {
          const path = args.path || "";
          const lines = (result || "").split("\n");
          const preview = lines.slice(0, 30).join("\n");
          const more = lines.length > 30 ? "\n<i>\u2026+" + (lines.length - 30) + " more lines</i>" : "";
          await sendMsg(
            header + "\n<code>" + escHtml(path) + "</code>  <i>(" + lines.length + " lines)</i>\n\n" +
            "<pre>" + escHtml(preview.slice(0, 2000)) + "</pre>" + more
          );
          break;
        }

        case "write_file": {
          const path = args.path || "";
          const size = (args.content || "").length;
          await sendMsg(header + "\n<code>" + escHtml(path) + "</code>\n<i>" + size + " chars written</i>");
          break;
        }

        case "replace_text": {
          const path = args.path || "";
          const oldSnip = (args.old || "").slice(0, 60).replace(/\n/g, "\u21b5");
          const newSnip = (args.new || "").slice(0, 60).replace(/\n/g, "\u21b5");
          await sendMsg(
            header + "\n<code>" + escHtml(path) + "</code>\n\n" +
            "<b>Before:</b> <code>" + escHtml(oldSnip) + "</code>\n" +
            "<b>After:</b>  <code>" + escHtml(newSnip) + "</code>"
          );
          break;
        }

        case "list_files": {
          const path = args.path || ".";
          const items = (result || "").split("\n").filter(Boolean);
          const dirs = items.filter(l => l.startsWith("\ud83d\udcc1"));
          const files = items.filter(l => l.startsWith("\ud83d\udcc4"));
          const text = items.slice(0, 40).join("\n");
          await sendMsg(
            header + "\n<code>" + escHtml(path) + "</code>\n" +
            "<i>" + dirs.length + " folders, " + files.length + " files</i>\n\n<pre>" + escHtml(text) + "</pre>"
          );
          break;
        }

        case "run_command": {
          if (!isErr && streamBuf) break;
          const cmd = args.command || "";
          const output = (result || "").split("\n").slice(0, 20).join("\n");
          await sendMsg(
            header + "\n<code>$ " + escHtml(cmd.slice(0, 100)) + "</code>\n\n" +
            "<pre>" + escHtml(output.slice(0, 2000)) + "</pre>"
          );
          break;
        }

        case "grep":
        case "search_in_files": {
          const lines = (result || "").split("\n").filter(Boolean);
          const pattern = args.pattern || args.query || "";
          const preview = lines.slice(0, 15).join("\n");
          await sendMsg(
            header + "\n<i>Pattern:</i> <code>" + escHtml(pattern) + "</code>\n" +
            "<i>" + lines.length + " matches</i>\n\n<pre>" + escHtml(preview.slice(0, 1500)) + "</pre>"
          );
          break;
        }

        case "search_web": {
          const query = args.query || args.q || "";
          const results = (result || "").split("\n\n").filter(Boolean).slice(0, 4);
          const text = results.join("\n\n");
          await sendMsg(
            header + "\n\ud83d\udd0d <i>" + escHtml(query) + "</i>\n\n" + escHtml(text.slice(0, 2500))
          );
          break;
        }

        case "python_eval": {
          const code = (args.code || "").split("\n").slice(0, 5).join("\n");
          const output = result || "";
          await sendMsg(
            header + "\n<pre>" + escHtml(code.slice(0, 300)) + "</pre>\n\n" +
            "<b>Output:</b>\n<pre>" + escHtml(output.slice(0, 800)) + "</pre>"
          );
          break;
        }

        case "git_status":
        case "git_diff": {
          const out = (result || "").split("\n").slice(0, 25).join("\n");
          await sendMsg(header + "\n<pre>" + escHtml(out.slice(0, 2000)) + "</pre>");
          break;
        }

        case "http_get": {
          const url = args.url || "";
          const lines = (result || "").split("\n");
          const status = lines[0] || "";
          const body = lines.slice(1, 6).join("\n");
          await sendMsg(
            header + "\n\ud83c\udf10 <code>" + escHtml(url.slice(0, 80)) + "</code>\n" +
            "<i>" + escHtml(status) + "</i>\n<pre>" + escHtml(body.slice(0, 500)) + "</pre>"
          );
          break;
        }

        case "create_dir":
        case "cd":
          await sendMsg(header + "\n<code>" + escHtml(result || "") + "</code>");
          break;

        case "delete_file":
          await sendMsg(header + "\n<code>" + escHtml(result || "") + "</code>");
          break;

        case "http_post": {
          const url = args.url || "";
          const method = args.method || "POST";
          const lines = (result || "").split("\n");
          const status = lines[0] || "";
          const body = lines.slice(2, 7).join("\n");
          await sendMsg(
            header + "\n\ud83d\udce1 <code>" + method + " " + escHtml(url.slice(0, 70)) + "</code>\n" +
            "<i>" + escHtml(status) + "</i>\n<pre>" + escHtml(body.slice(0, 600)) + "</pre>"
          );
          break;
        }

        case "find_files": {
          const found = (result || "").split("\n").filter(l => l && !l.startsWith("Found"));
          const summary = (result || "").split("\n")[0] || "";
          await sendMsg(
            header + "\n\ud83d\uddc2\ufe0f <i>" + escHtml(summary) + "</i>\n\n<pre>" + escHtml(found.slice(0, 30).join("\n")) + "</pre>"
          );
          break;
        }

        case "zip": {
          await sendMsg(header + "\n<code>" + escHtml(result || "") + "</code>");
          break;
        }

        case "diff_files": {
          const lines = (result || "").split("\n");
          const summary = lines.slice(0, 2).join("\n");
          const diff = lines.slice(3, 25).join("\n");
          await sendMsg(
            header + "\n<i>" + escHtml(summary) + "</i>\n\n<pre>" + escHtml(diff.slice(0, 2000)) + "</pre>"
          );
          break;
        }

        case "lint": {
          const issues = (result || "").split("\n").filter(Boolean);
          const icon = isErr || result?.includes("\u274c") ? "\ud83d\udd34" : "\ud83d\udfe2";
          await sendMsg(
            header + " " + icon + "\n<pre>" + escHtml(issues.slice(0, 20).join("\n").slice(0, 1500)) + "</pre>"
          );
          break;
        }

        default:
          if (isErr) {
            await sendMsg(header + "\n<pre>" + escHtml((result || "").slice(0, 500)) + "</pre>");
          }
          break;
      }
    }
  });
}

//