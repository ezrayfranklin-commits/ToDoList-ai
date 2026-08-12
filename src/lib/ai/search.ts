// Web search for the chat agent (内置联网搜索工具).
//
// 搜索引擎: DuckDuckGo 优先（Google 服务器端抓取常被拦截）；
// Google 作为 fallback（可通过 GOOGLE_SEARCH_BASE_URL 配置镜像）。
// 无需 API key。webview 内通过 tauri-plugin-http 发起请求（无 CORS 问题）。

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOutcome {
  engine: string;
  results: SearchResult[];
  error?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Pure parsing helpers (无外部依赖)
// ---------------------------------------------------------------------------

export function htmlDecode(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeGoogleRedirect(href: string): string {
  // Google result links look like /url?q=https%3A%2F%2Freal.url%2F&sa=U&...
  const m = href.match(/[?&]q=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      // fall through to raw href
    }
  }
  return href;
}

export function parseGoogleHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const rawHref = m[1];
    const title = stripTags(m[2]);
    if (!title || title.length < 4) continue;
    let url = "";
    if (rawHref.startsWith("/url?q=")) {
      url = decodeGoogleRedirect(rawHref);
    } else if (rawHref.startsWith("http")) {
      url = rawHref;
    } else {
      continue;
    }
    if (url.includes("google.com") && !url.includes("google.com/url")) continue;
    if (seen.has(url)) continue;
    const snippetMatch = html.slice(linkRe.lastIndex, linkRe.lastIndex + 3000).match(
      /<div[^>]*class="[^"]*(?:VwiC3b|snippet)[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    seen.add(url);
    results.push({ title, url, snippet: snippet.slice(0, 300) });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    // DDG links look like //duckduckgo.com/l/?uddg=https%3A%2F%2Freal.url — decode the real URL
    let url = htmlDecode(m[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        // keep raw url
      }
    }
    const title = stripTags(m[2]);
    const snipMatch = html.slice(linkRe.lastIndex, linkRe.lastIndex + 2000).match(
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/,
    );
    const snippet = snipMatch ? stripTags(snipMatch[1]) : "";
    results.push({ title, url, snippet: snippet.slice(0, 300) });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function parseBingHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  // Bing results are <li class="b_algo"> blocks containing <h2><a href="...">Title</a></h2>
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    let url = htmlDecode(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    if (!title || title.length < 4) continue;
    if (!url.startsWith("http")) continue;
    if (seen.has(url)) continue;
    const snipMatch = block.match(
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>|<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    const snippet = snipMatch ? stripTags(snipMatch[1] ?? snipMatch[2] ?? "") : "";
    seen.add(url);
    results.push({ title, url, snippet: snippet.slice(0, 300) });
    if (results.length >= maxResults) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Fetchers (fetch 可注入: Tauri webview 用 plugin-http, node 测试用原生 fetch)
// ---------------------------------------------------------------------------

let tauriFetchFn: typeof fetch | null = null;

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!tauriFetchFn) {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetchFn = mod.fetch as unknown as typeof fetch;
  }
  return tauriFetchFn(input, init);
}

async function fetchDuckDuckGo(
  query: string,
  maxResults: number,
  fetchImpl: typeof fetch,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo returned HTTP ${resp.status}`);
  const html = await resp.text();
  const results = parseDuckDuckGoHtml(html, maxResults);
  if (results.length === 0) throw new Error("DuckDuckGo returned no parseable results");
  return results;
}

async function fetchGoogle(
  query: string,
  maxResults: number,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<SearchResult[]> {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&num=${maxResults}&hl=zh-CN`;
  const resp = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Google returned HTTP ${resp.status}`);
  const html = await resp.text();
  const results = parseGoogleHtml(html, maxResults);
  if (results.length === 0) throw new Error("Google returned no parseable results (bot check?)");
  return results;
}

async function fetchBing(
  query: string,
  maxResults: number,
  fetchImpl: typeof fetch,
): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&count=${maxResults}`;
  const resp = await fetchImpl(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      // Bing 会对无浏览器特征请求 302 跳转到 cn.bing.com, 跟随即可
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Bing returned HTTP ${resp.status}`);
  const html = await resp.text();
  const results = parseBingHtml(html, maxResults);
  if (results.length === 0) throw new Error("Bing returned no parseable results");
  return results;
}

/**
 * Search the web. DuckDuckGo first (Google scraping is unreliable and the
 * user asked for DDG), Google as a fallback when DDG fails.
 */
export async function webSearch(
  query: string,
  maxResults = 8,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<SearchOutcome> {
  // 隐私: 联网搜索会把搜索词发送到 DuckDuckGo (DDG 失败时回退 Google)
  const q = query.trim();
  if (!q) return { engine: "none", results: [], error: "query must not be empty" };
  const n = Math.min(Math.max(maxResults, 1), 20);
  const baseUrl =
    (globalThis as Record<string, unknown>).process !== undefined
      ? ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
          ?.GOOGLE_SEARCH_BASE_URL ?? "https://www.google.com")
      : "https://www.google.com";

  // DuckDuckGo first (primary engine per requirement)
  try {
    const results = await fetchDuckDuckGo(q, n, fetchImpl);
    return { engine: "duckduckgo", results };
  } catch (ddgErr) {
    // Google fallback
    try {
      const results = await fetchGoogle(q, n, baseUrl, fetchImpl);
      return { engine: "google (ddg failed: " + (ddgErr as Error).message + ")", results };
    } catch (googleErr) {
      // Bing last-resort fallback (DuckDuckGo/Google 反爬时可用)
      try {
        const results = await fetchBing(q, n, fetchImpl);
        return { engine: "bing (ddg: " + (ddgErr as Error).message + "; google: " + (googleErr as Error).message + ")", results };
      } catch (bingErr) {
        return {
          engine: "none",
          results: [],
          error:
            `Search failed on all engines.\n` +
            `DuckDuckGo error: ${(ddgErr as Error).message}\n` +
            `Google error: ${(googleErr as Error).message}\n` +
            `Bing error: ${(bingErr as Error).message}`,
        };
      }
    }
  }
}
