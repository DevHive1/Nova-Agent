// ============================================================
//  server/tools/web.js  —  Web Scraping and Search Tools
// ============================================================

/**
 * Fetch a URL, normalize HTML by stripping script/style tags, and return text.
 */
async function toolHttpGet(url) {
  if (!url) return "ERROR: no URL provided";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
    "Accept": "text/html,application/json,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
  };

  for (const attempt of [url, url.replace("https://", "http://")]) {
    try {
      const res = await fetch(attempt, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20000),
        redirect: "follow"
      });
      const ct = res.headers.get("content-type") || "";
      let text = await res.text();

      if (ct.includes("html")) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{3,}/g, "\n")
          .trim();
      }
      return `STATUS:${res.status}\nURL:${attempt}\n\n${text.slice(0, 5000)}${text.length > 5000 ? "\n...[truncated]" : ""}`;
    } catch (e) {
      if (attempt === url && url.startsWith("https://")) continue;
      return `ERROR: ${e.message}`;
    }
  }
  return "ERROR: Failed to fetch URL";
}

/**
 * Generate a set of query variations to maximize hit rate
 */
function generateQueryVariations(query) {
  const variations = new Set([query]);
  
  // 1. Remove common question starters
  const cleaned = query
    .replace(/^(what is|what's|who is|who's|how to|how do|where is|when did|tell me about)/i, "")
    .replace(/\?$/, "")
    .trim();
  if (cleaned && cleaned !== query) variations.add(cleaned);
  
  // 2. Broaden by removing trailing specific words (e.g., "Node.js tutorial" -> "Node.js")
  const words = query.split(/\s+/);
  if (words.length > 1) {
    for (let i = words.length - 1; i > 0; i--) {
      variations.add(words.slice(0, i).join(" "));
    }
  }
  
  // 3. Try just the core noun (first word if it's a likely topic)
  if (words.length > 0) variations.add(words[0]);

  return Array.from(variations);
}

/**
 * Process DuckDuckGo API response into a result string
 */
function processDDGResponse(d) {
  const out = [];
  if (d.AbstractText && d.AbstractText.length > 10) {
    out.push(`[Answer] ${d.AbstractText}`);
    if (d.AbstractURL) out.push(`[Source] ${d.AbstractURL}`);
  }
  if (d.Definition && d.Definition.length > 10 && !d.AbstractText) {
    out.push(`[Definition] ${d.Definition}`);
    if (d.DefinitionURL) out.push(`[Source] ${d.DefinitionURL}`);
  }
  if (d.RelatedTopics && d.RelatedTopics.length > 0) {
    d.RelatedTopics.slice(0, 8).forEach((t, i) => {
      if (t.Text && t.FirstURL) {
        const cleanText = t.Text.replace(/<[^>]+>/g, "").trim();
        if (cleanText && cleanText.length > 5) {
          out.push(`[${i + 1}] ${cleanText}\n${t.FirstURL}`);
        }
      }
    });
  }
  return out.join("\n\n");
}

/**
 * Search the web using a parallel strategy to avoid sequential failures
 */
async function toolSearchWeb(query) {
  if (!query || !query.trim()) return "ERROR: no query provided";
  query = query.trim();
  const HEADERS = { 
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const variations = generateQueryVariations(query);
  
  // Fire all requests in parallel
  const searchPromises = variations.map(async (q) => {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      const d = await res.json();
      const result = processDDGResponse(d);
      return { q, result, score: result.length };
    } catch {
      return { q, result: "", score: 0 };
    }
  });

  const allResults = await Promise.all(searchPromises);
  
  // Pick the result with the most content (highest score)
  const best = allResults.reduce((prev, curr) => (curr.score > prev.score) ? curr : prev, { q: "", result: "", score: 0 });

  if (best.result) {
    const prefix = best.q !== query ? `[Optimized search for: ${best.q}]\n\n` : "";
    return prefix + best.result;
  }

  // Final fallback: Try HTML search for the original query
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    const html = await res.text();
    if (html.includes("result__a") && !html.includes("lite_wrapper")) {
      const results = [];
      const re = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([^<]*)<\/a>/g;
      let m;
      while ((m = re.exec(html)) !== null && results.length < 8) {
        results.push(`[${results.length + 1}] ${m[2].trim()}\n${m[3].trim()}\n${m[1]}`);
      }
      if (results.length > 0) return results.join("\n\n");
    }
  } catch {}

  return `No results found for: ${query}\n\nTips:\n- Try a more specific topic (e.g., "React JavaScript library")\n- Avoid generic terms like "test"`;
}

// ─── http_post ─────────────────────────────────────────────────
async function toolHttpPost(args) {
  const url     = args.url;
  const method  = (args.method || "POST").toUpperCase();
  const body    = args.body || args.data || args.payload || {};
  const headers = args.headers || {};

  if (!url) return "ERROR: 'url' parameter required";
  const finalUrl = url.startsWith("http") ? url : "https://" + url;

  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const finalHeaders = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; CodingAgent/1.0)",
    ...headers,
  };

  try {
    const res = await fetch(finalUrl, {
      method: method,
      headers: finalHeaders,
      body: bodyStr,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    const truncated = pretty.length > 4000;
    return (
      `STATUS:${res.status}\nURL:${finalUrl}\nMETHOD:${method}\n\n` +
      pretty.slice(0, 4000) +
      (truncated ? "\n...[truncated]" : "")
    );
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

module.exports = {
  httpGet:  a => toolHttpGet(a.url),
  httpPost: a => toolHttpPost(a),
  searchWeb: a => toolSearchWeb(a.query || a.q || a.search || ""),
};export {};
