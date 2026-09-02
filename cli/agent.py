# ============================================================
#  cli/agent.py  —  CLI Agent Main Loop
# ============================================================

import os
import re
import sys
import json
import shutil
from pathlib import Path
from datetime import datetime

# Fix Python path for relative imports
sys.path.insert(0, str(Path(__file__).parent))

from ui import clr, C, info, ok, warn, err, thought, tool_ev, step_ev, result_ev, print_banner
from tools import (
    CWD, _bg_procs, execute_tool, list_processes, kill_process,
    cd, screenshot, UPLOAD_DIR, resolve
)

try:
    import requests
except ImportError:
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "requests", "--break-system-packages", "-q"])
    import requests


# ─── STATE FOR CANCELLATION ──────────────────────────────────
class CancelledError(Exception):
    pass

# ─── CONFIG ───────────────────────────────────────────────────
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/chat")
MODEL = os.getenv("AGENT_MODEL", "qwen3-coder-next:cloud")
MAX_STEPS = int(os.getenv("MAX_STEPS", "30"))
CONTEXT_FILE = ".agent_state.json"
LOG_FILE = ".agent_log.jsonl"
MAX_CTX_CHARS = 14_000
MAX_HISTORY_MSGS = 30

SYSTEM_PROMPT = """You are NOVA — an advanced AI coding agent (2026). Senior full-stack engineer.

## Available Tools

### Filesystem
- read_file(path) — read file with line numbers
- read_lines(path, start, end) — read specific line range — USE FOR LARGE FILES
- write_file(path, content) — create or overwrite file
- append_file(path, content) — append to file
- replace_text(path, old, new) — targeted find-and-replace
- list_files(path) — list directory (call at most ONCE per directory)
- search_in_files(pattern, directory) — search text across files
- grep(pattern, path) — regex search
- create_dir(path) — create directory
- delete_file(path) — delete file/dir

### Shell & Code
- run_command(command) — execute shell command
- python_eval(code) — run Python code

### Git
- git_status() — git status
- git_diff(file?) — git diff

### Web & APIs
- http_get(url) — fetch URL content
- http_post(url, body, method, headers) — POST/PUT/PATCH to any API with JSON body
- search_web(query) — search DuckDuckGo

### File Discovery & Archives
- find_files(pattern, directory, ext, maxdepth) — find files by name or extension
- zip(action, archive, source, dest) — create/extract/list zip or tar.gz archives
- diff_files(file1, file2) — unified diff between any two files

### Code Quality
- lint(file, linter) — run ESLint (JS), flake8 (Python), or syntax check

### Other
- screenshot(url_or_path) — take screenshot
- cd(path) — change directory
- ask_human(question) — ask user for clarification
- think(thought) — plan complex tasks before acting
- sequential_thinking(thought, thoughtNumber, totalThoughts, nextThoughtNeeded) — Break down complex problems step-by-step

## Response Format
ALWAYS respond with ONLY a single valid JSON object. NO markdown, NO extra text.

Use tool: {"thought":"<why>","tool":"<name>","args":{...}}
Finished: {"thought":"<summary>","final":"<message to user>"}

## CRITICAL JSON Rules
- Output ONLY the JSON object — nothing before or after
- Never wrap in ```json or any markdown fences
- Escape all special characters: newlines → \\n, tabs → \\t, quotes → \\"

## Efficiency Rules — MUST FOLLOW
1. NEVER call list_files on the same directory more than once
2. Use read_lines for large files — NOT read_file repeatedly
3. Use think or sequential_thinking to plan complex multi-step tasks before starting
4. Don't re-read files you've already read
5. Once work is verified, return {"final":"..."} immediately — do NOT loop

## Engineering Standards (2026)
- Always read_file before editing
- Use replace_text for small changes, write_file for new files
- After writing code, verify with run_command
- Use ask_human when requirements are unclear
- Never store secrets in code — use environment variables
- Handle ALL error cases explicitly"""

# ─── STATE MANAGEMENT ─────────────────────────────────────────
def save_state(ctx, hist):
    capped = hist[-MAX_HISTORY_MSGS:] if len(hist) > MAX_HISTORY_MSGS else hist
    data = {"saved_at": datetime.now().isoformat(), "context": ctx, "history": capped}
    Path(CONTEXT_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2))

def load_state():
    if Path(CONTEXT_FILE).exists():
        try:
            d = json.loads(Path(CONTEXT_FILE).read_text())
            return d.get("context", ""), d.get("history", [])
        except:
            pass
    return "", []

def clear_state():
    for f in [CONTEXT_FILE, LOG_FILE]:
        if Path(f).exists():
            Path(f).unlink()

def append_log(e):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    except:
        pass

# ─── ROBUST JSON PARSER ──────────────────────────────────────
def clean_json(raw):
    if not raw: return "{}"
    try:
        json.loads(raw)
        return raw
    except:
        pass
    # Strip fences
    s = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.M)
    s = re.sub(r'\s*```\s*$', '', s, flags=re.M).strip()
    try:
        json.loads(s)
        return s
    except:
        pass
    # Extract first { ... } with brace matching
    depth = 0; start = -1; in_str = False; esc = False
    for i, c in enumerate(raw):
        if esc: esc = False; continue
        if c == '\\' and in_str: esc = True; continue
        if c == '"': in_str = not in_str; continue
        if in_str: continue
        if c == '{':
            if depth == 0: start = i
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0 and start != -1:
                candidate = raw[start:i+1]
                try:
                    json.loads(candidate)
                    return candidate
                except:
                    pass
    # Manual extraction fallback
    t = re.search(r'"thought"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
    tl = re.search(r'"tool"\s*:\s*"([^"]+)"', raw)
    fn = re.search(r'"final"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
    thought_v = t.group(1) if t else ""
    if tl:
        return json.dumps({"thought": thought_v, "tool": tl.group(1), "args": {}})
    if fn:
        return json.dumps({"thought": thought_v, "final": fn.group(1)})
    return json.dumps({"__plain__": True, "text": raw})

# ─── OLLAMA CALL ──────────────────────────────────────────────
def ask_ollama(messages):
    try:
        r = requests.post(OLLAMA_URL, json={
            "model": MODEL,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.2}
        }, timeout=300)
        r.raise_for_status()
        return r.json()["message"]["content"]
    except requests.exceptions.ConnectionError as e:
        return json.dumps({"thought": "API error", "final": f"Ollama is not running. Please start Ollama first: 'ollama serve' then 'ollama pull {MODEL}'"})
    except requests.exceptions.Timeout as e:
        return json.dumps({"thought": "API error", "final": f"Ollama timeout: {e}"})
    except Exception as e:
        return json.dumps({"thought": "API error", "final": f"Ollama error: {e}"})

# ─── AGENT LOOP ───────────────────────────────────────────────
def run_agent(user_request, context, chat_history, image_paths=None):
    cwd_note = f"\n\n## Current Working Directory\n{CWD[0]}"
    resume = f"\n\n## Resumed Session Context\n{context}" if context else ""
    sys_p = SYSTEM_PROMPT + cwd_note + resume

    # Cap history to prevent token explosion
    capped_history = chat_history[-MAX_HISTORY_MSGS:] if len(chat_history) > MAX_HISTORY_MSGS else chat_history

    messages = [{"role": "system", "content": sys_p}] + capped_history

    user_content = user_request
    if image_paths:
        img_list = ", ".join(str(p) for p in image_paths)
        user_content += f"\n\n[Attached images: {img_list}]"

    messages.append({"role": "user", "content": user_content})

    ctx = context
    for n in range(1, MAX_STEPS + 1):
        try:
            step_ev(n)
            raw = ask_ollama(messages)
            cleaned = clean_json(raw)
            try:
                data = json.loads(cleaned)
            except:
                ok("Plain text response.")
                messages.append({"role": "assistant", "content": raw})
                ctx += f"\n\n[Step {n}] Final: {raw[:500]}"
                save_state(ctx, messages[1:])
                return raw, ctx, messages[1:]

            if data.get("__plain__"):
                ok("Response.")
                print(f"\n  {data['text'][:500]}\n")
                messages.append({"role": "assistant", "content": raw})
                ctx += f"\n\n[Step {n}] Final: {data['text'][:300]}"
                save_state(ctx, messages[1:])
                return data["text"], ctx, messages[1:]

            if data.get("thought"):
                thought(data["thought"])

            if "final" in data:
                ok("Done.")
                messages.append({"role": "assistant", "content": raw})
                ctx += f"\n\n[Step {n}] Final: {data['final'][:300]}"
                save_state(ctx, messages[1:])
                append_log({"step": n, "final": data["final"]})
                return data["final"], ctx, messages[1:]

            tool_name = data.get("tool")
            args = data.get("args", {})
            if not tool_name:
                # Model didn't specify a tool - ask it to provide final answer or use a tool
                messages.append({"role": "assistant", "content": raw})
                messages.append({"role": "user", "content":
                    'You did not specify a tool. Either provide a final answer with {"thought":"...","final":"..."} or use a tool. Do not repeat the same response.'
                })
                continue

            # Handle "none" tool — model thinks no tool is needed but didn't use {"final":"..."}
            NONE_TOOL_NAMES = {"none", "null", "n/a", "no_tool", "no tool", "finish", "done", "respond"}
            if str(tool_name).lower().strip() in NONE_TOOL_NAMES:
                messages.append({"role": "assistant", "content": raw})
                messages.append({"role": "user", "content":
                    'You do not need a tool for this. Respond with ONLY: {"thought":"<brief>","final":"<your answer>"}'
                })
                continue

            # think & sequential_thinking tools: show thought but don't print result to user
            if tool_name in ("think", "sequential_thinking"):
                t_val = args.get("thought", args.get("reasoning", ""))
                if tool_name == "think":
                    thought(f"[Planning] {t_val}")
                    result = "Thought recorded. Proceed with your plan."
                else:
                    t_num = args.get("thoughtNumber", args.get("thought_number", 1))
                    tot = args.get("totalThoughts", args.get("total_thoughts", 1))
                    next_needed = args.get("nextThoughtNeeded", args.get("next_thought_needed", True))
                    if isinstance(next_needed, str):
                        next_needed = next_needed.lower() != 'false'
                    thought(f"[Thinking {t_num}/{tot}] {t_val}")
                    result = f"Thought #{t_num}/{tot} processed. {'Next thought step needed.' if next_needed else 'Ready to proceed with action.'}"
                messages.append({"role": "assistant", "content": raw})
                messages.append({"role": "user", "content": f"[Tool result: {tool_name}]\n{result}"})
                ctx += f"\n\n[Step {n}] {tool_name}: {t_val[:200]}"
                continue

            tool_ev(tool_name, args)
            result = execute_tool(tool_name, args)
            result_ev(result)
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": f"[Tool result: {tool_name}]\n{result}"})
            ctx += f"\n\n[Step {n}] {tool_name}: {str(result)[:300]}"
            if len(ctx) > MAX_CTX_CHARS:
                ctx = f"[Original task]\n{user_request}\n\n[...trimmed...]\n\n{ctx[-4000:]}"
            append_log({"step": n, "tool": tool_name, "args": args, "result": str(result)[:300]})

        except (KeyboardInterrupt, EOFError):
            warn("Task cancelled.")
            save_state(ctx, messages[1:])
            raise CancelledError()

    warn(f"Reached {MAX_STEPS} steps. State saved. Type 'continue' to resume.")
    save_state(ctx, messages[1:])
    return "PAUSED", ctx, messages[1:]

# ─── ATTACH IMAGE ─────────────────────────────────────────────
def attach_image(path):
    abs_p = Path(resolve(path))
    if not abs_p.exists():
        err(f"File not found: {path}")
        return None
    dest = UPLOAD_DIR / f"cli_{int(datetime.now().timestamp())}_{abs_p.name}"
    shutil.copy(abs_p, dest)
    ok(f"Attached: {dest}")
    return dest

# ─── MAIN SHELL LOOP ──────────────────────────────────────────
def main():
    global MODEL
    print_banner()
    context, chat_history = load_state()
    if context:
        warn(f"Resumed session. Type 'continue' to pick up.")
    else:
        info(f"CWD: {CWD[0]}")
    print(clr(C.DIM, "  /help for commands\n"))

    pending_images = []

    # One-shot mode: python -m cli "task"
    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
        try:
            answer, context, chat_history = run_agent(task, context, chat_history)
        except CancelledError:
            err("Task cancelled.")
            return
        if answer != "PAUSED":
            print(f"\n{clr(C.GREEN + C.BOLD, '  NOVA:')}\n  {answer}\n")
        return

    while True:
        try:
            prompt = clr(C.BOLD + C.WHITE, f"[{Path(CWD[0]).name}]>>> ")
            user = input(prompt).strip()
        except EOFError:
            print()
            ok("Bye!")
            break
        except KeyboardInterrupt:
            print()
            continue
        if not user:
            continue

        lo = user.lower()

        if lo in ("exit", "quit"):
            ok("Bye!")
            break

        if lo == "/help":
            print(f"""
  {clr(C.BOLD, 'Commands:')}
  Ctrl+C             Cancel current task
  Ctrl+D / exit      Exit the CLI
  /clear             Clear session state
  /status            Show session info
  /log               Show last 10 log entries
  /model <name>      Switch Ollama model
  /tools             List all available tools
  /ps                Show background processes
  /kill <id>         Kill a background process
  /attach <path>     Attach image to next message
  /screenshot <url>  Take a screenshot
  /save [filename]   Export session to markdown file
  /cwd               Show current directory
  /cd <path>         Change directory
  continue           Resume a paused session
""")
            continue

        if lo == "/clear":
            clear_state()
            context, chat_history = "", []
            pending_images = []
            ok("Session cleared.")
            continue

        if lo == "/status":
            info(f"Model: {MODEL}")
            info(f"CWD: {CWD[0]}")
            info(f"Context: {len(context)} chars")
            info(f"History: {len(chat_history)} messages")
            if pending_images:
                info(f"Pending images: {len(pending_images)}")
            continue

        if lo == "/ps":
            list_processes()
            continue

        if lo.startswith("/kill "):
            try:
                kill_process(int(lo.split()[1]))
            except:
                err("Usage: /kill <id>")
            continue

        if lo.startswith("/model "):
            MODEL = user[7:].strip()
            ok(f"Model: {MODEL}")
            continue

        if lo == "/tools":
            from tools import TOOL_MAP
            print("\n  " + "\n  ".join(f"• {t}" for t in sorted(TOOL_MAP.keys())) + "\n")
            continue

        if lo == "/cwd":
            info(f"CWD: {CWD[0]}")
            continue

        if lo.startswith("/cd "):
            cd(user[4:].strip())
            continue

        if lo.startswith("/attach "):
            img = attach_image(user[8:].strip())
            if img:
                pending_images.append(img)
            continue

        if lo.startswith("/screenshot "):
            target = user[12:].strip()
            result = screenshot(target)
            info(result)
            if "SCREENSHOT:" in result:
                path = result.split("SCREENSHOT:")[1].split("\n")[0].strip()
                pending_images.append(Path(path))
                info("Screenshot attached to next message.")
            continue

        if lo.startswith("/save"):
            parts = user.split(None, 1)
            filename = parts[1].strip() if len(parts) > 1 else f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
            if not filename.endswith(".md"):
                filename += ".md"
            try:
                lines = [f"# Agent Session — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"]
                lines.append(f"**Model:** {MODEL}  |  **CWD:** {CWD[0]}\n\n---\n")
                for msg in chat_history:
                    role = msg.get("role", "?")
                    content = msg.get("content", "")
                    if role == "system":
                        continue
                    if role == "user" and content.startswith("[Tool result:"):
                        lines.append(f"> {content[:200]}\n\n")
                    elif role == "user":
                        lines.append(f"### 👤 User\n{content}\n\n")
                    elif role == "assistant":
                        try:
                            d = json.loads(content)
                            if "final" in d:
                                lines.append(f"### 🤖 Agent\n{d['final']}\n\n")
                            elif "tool" in d:
                                args_str = json.dumps(d.get("args", {}), ensure_ascii=False)[:200]
                                lines.append(f"**Tool:** `{d['tool']}({args_str})`\n\n")
                        except Exception:
                            lines.append(f"### 🤖 Agent\n{content[:500]}\n\n")
                Path(filename).write_text("".join(lines), encoding="utf-8")
                ok(f"Session saved to {filename}")
            except Exception as e:
                err(f"Could not save: {e}")
            continue

        if lo == "/log":
            if Path(LOG_FILE).exists():
                for line in Path(LOG_FILE).read_text().splitlines()[-10:]:
                    try:
                        e = json.loads(line)
                        print(f"  Step {e.get('step', '?')} │ {e.get('tool', e.get('final', '?'))[:60]}")
                    except:
                        print(f"  {line[:60]}")
            else:
                info("No log yet.")
            continue

        if lo == "continue":
            if not context:
                warn("No paused session.")
                continue
            user = "Continue the previous task from where you left off. Review the context and proceed."

        imgs = pending_images.copy()
        pending_images.clear()

        try:
            answer, context, chat_history = run_agent(user, context, chat_history, imgs)
        except CancelledError:
            warn("Task cancelled. Session saved. You can continue later.")
            continue

        print()
        if answer == "PAUSED":
            warn("Paused. Type 'continue' to resume, or start a new task.")
        else:
            print(clr(C.BOLD + C.GREEN, "  NOVA:"))
            for line in answer.splitlines():
                print(f"  {line}")
        print()

if __name__ == "__main__":
    main()
