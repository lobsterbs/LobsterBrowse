/* AI mode storage and provider clients.
   The Cloudflare Workers AI key is SERVER-SIDE: streamChat posts to
   this origin's /ai/chat proxy, which holds CLOUDFLARE_AI_KEY and
   CLOUDFLARE_ACCOUNT_ID on the deployment and enforces the rate
   limit (50 messages per rolling 6 h). The remaining count rides the
   x-lb-ai-remaining response header. Web search is model-invoked
   function calling (the web_search tool) and keyless: Exa's free MCP
   endpoint (mcp.exa.ai) answers with no account. Chats
   persist encrypted in IndexedDB with a non-exportable key. By
   design there is no key export: losing the browser profile loses
   the chats. */

import { loadDebugOverrides } from "../debug.ts";

const KEY_MODEL = "lobsterbrowse-ai-model";

export interface AiModel {
  id: string;
  name: string;
  version: string;
  params: string;
  note: string;
  thinking: boolean;
  mark: string;
  vision: boolean;
}

/* Parameter lines stay honest: all four verified against the live
   Workers AI catalog on 2026-10-30 (prices per M tokens in/out):
   gpt-oss-120b $0.35/$0.75 (128k context, reasoning, function
   calling), gpt-oss-20b $0.20/$0.30, qwen3-30b-a3b-fp8 $0.051/$0.335
   (MoE, 3B active, reasons on every turn), llama-4-scout $0.27/$0.85
   (vision + function calling; the only model here that accepts image
   parts). The deployment account runs the Workers Free plan (10,000
   neurons/day), so the gated GLM/DeepSeek/Kimi tier is unavailable.
   The marks are the providers' official logos (CC0 simple-icons
   geometry). */
const OPENAI_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z"/></svg>';
const QWEN_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M23.919 14.545L20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828l-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801l-6.205-.002l1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315l-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z"/></svg>';
const META_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"/></svg>';

export const AI_MODELS: AiModel[] = [
  { id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS", version: "1", params: "120B", note: "128k context, reasoning, function calling", thinking: true, vision: false, mark: OPENAI_MARK },
  { id: "@cf/openai/gpt-oss-20b", name: "GPT-OSS", version: "1", params: "20B", note: "fast, lightweight reasoning", thinking: true, vision: false, mark: OPENAI_MARK },
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen", version: "3", params: "30B", note: "MoE, 3B active, reasons every turn", thinking: true, vision: false, mark: QWEN_MARK },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Scout", version: "Llama 4", params: "17B", note: "vision: reads your images", thinking: false, vision: true, mark: META_MARK },
];

export function loadModelId(): string {
  try {
    const v = localStorage.getItem(KEY_MODEL);
    return v && AI_MODELS.some((m) => m.id === v) ? v : AI_MODELS[0].id;
  } catch {
    return AI_MODELS[0].id;
  }
}

export function saveModelId(id: string): void {
  try {
    localStorage.setItem(KEY_MODEL, id);
  } catch {
    /* ignore */
  }
}

/* ---- dynamic thinking: heuristic prompt classification ----
   ponytail: keyword heuristic, upgrade to a classifier only if this
   misfires often in practice. */

const THINKING_RE =
  /\b(why|how|explain|solve|prove|derive|compare|analy[sz]e|plan|design|reason|evaluate|calculate|estimate|debug|trade-?offs?|step by step)\b/i;

export function needsThinking(prompt: string): boolean {
  if (prompt.length > 600) return true;
  if (THINKING_RE.test(prompt)) return true;
  if (/[0-9]\s*[-+*/^%]\s*[0-9]/.test(prompt)) return true;
  return false;
}

/* ---- encrypted chat persistence (IndexedDB, non-exportable key) ---- */

export interface AiSource {
  title: string;
  url: string;
  snippet: string;
}

export interface AiMsg {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  sources?: AiSource[];
  model?: string;
  files?: string[];
}

export interface AiChat {
  id?: number;
  title: string;
  messages: AiMsg[];
  updated: number;
}

const DB_NAME = "lobsterbrowse-ai";
const DB_VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
        if (!d.objectStoreNames.contains("chats"))
          d.createObjectStore("chats", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    });
  }
  return dbp;
}

/* The key is generated with extractable:false: it can never leave the
   browser, and the ciphertext is worthless without it. */
async function getKey(d: IDBDatabase): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const tx = d.transaction("meta", "readonly");
    const get = tx.objectStore("meta").get("ckey");
    get.onsuccess = () => {
      if (get.result) {
        resolve(get.result as CryptoKey);
        return;
      }
      void crypto.subtle
        .generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        .then((key) => {
          const tx2 = d.transaction("meta", "readwrite");
          tx2.objectStore("meta").put(key, "ckey");
          tx2.oncomplete = () => resolve(key);
          tx2.onerror = () => reject(tx2.error ?? new Error("key store write failed"));
        })
        .catch(reject);
    };
    get.onerror = () => reject(get.error ?? new Error("key store read failed"));
  });
}

export async function saveChat(chat: AiChat): Promise<number> {
  const d = await openDb();
  const key = await getKey(d);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(chat));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  const rec: { id?: number; updated: number; iv: Uint8Array; ct: ArrayBuffer } = {
    updated: Date.now(),
    iv,
    ct,
  };
  if (chat.id !== undefined) rec.id = chat.id;
  return new Promise((resolve, reject) => {
    const tx = d.transaction("chats", "readwrite");
    const req = tx.objectStore("chats").put(rec);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error ?? new Error("chat write failed"));
  });
}

export async function listChats(): Promise<AiChat[]> {
  const d = await openDb();
  const key = await getKey(d);
  const recs = await new Promise<{ id: number; updated: number; iv: Uint8Array; ct: ArrayBuffer }[]>(
    (resolve, reject) => {
      const tx = d.transaction("chats", "readonly");
      const req = tx.objectStore("chats").getAll();
      req.onsuccess = () =>
        resolve(req.result as { id: number; updated: number; iv: Uint8Array; ct: ArrayBuffer }[]);
      req.onerror = () => reject(req.error ?? new Error("chat read failed"));
    }
  );
  const out: AiChat[] = [];
  for (const r of recs) {
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(r.iv) }, key, r.ct);
      const chat = JSON.parse(new TextDecoder().decode(pt)) as AiChat;
      chat.id = r.id;
      chat.updated = r.updated;
      out.push(chat);
    } catch {
      /* undecryptable record (lost key): skip it */
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/* Called from store.ts clearAllData(): close any open connection so
   the delete is not blocked, then remove the database entirely. */
export async function wipeAiData(): Promise<void> {
  if (dbp) {
    try {
      (await dbp).close();
    } catch {
      /* ignore */
    }
    dbp = null;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    const done = () => resolve();
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = done;
  });
}

/* ---- mock mode (debug menu "Mock AI responses"): canned local
   data, zero network. Everything the AI page can do is mocked: the
   search sources, the reasoning stream, and the word-by-word answer.
   The flag lives in the debug overrides (localStorage), so it survives
   reloads and the debug menu "Clear overrides" clears it. */
export function isMocked(): boolean {
  return loadDebugOverrides().aiMock === true;
}

const MOCK_SOURCES: AiSource[] = [
  { title: "Mock result one", url: "https://example.com/mock-one", snippet: "A canned search result produced locally by mock mode." },
  { title: "Mock result two", url: "https://example.com/mock-two", snippet: "Second canned result; no Exa request was made." },
];

const mockWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function* mockStream(thinking: boolean): AsyncGenerator<StreamEvent> {
  if (thinking) {
    for (const step of ["Reading the question.", "Weighing the mock sources.", "Drafting the mock answer."]) {
      await mockWait(350);
      yield { type: "thinking", text: step + "\n" };
    }
  }
  const answer =
    "This is a mock answer produced locally by the debug menu. No AI API call and no Exa search " +
    "happened. It cites the mock sources [1] and [2] so the reasoning panel, the streamed text, and " +
    "the source chips render exactly as they do against the real APIs.";
  for (const word of answer.split(" ")) {
    await mockWait(40);
    yield { type: "text", text: word + " " };
  }
}

/* ---- web search: Exa MCP (https://mcp.exa.ai/mcp) ----
   Keyless by design: Exa serves free, rate-limited search over MCP
   with no account or key, and the endpoint is CORS-open from the
   browser (verified live). Streamable HTTP MCP: one initialize
   handshake, keep the session id, then tools/call web_search_exa. */

const EXA_MCP = "https://mcp.exa.ai/mcp";
let exaSession: string | null = null;

type ExaJson = Record<string, unknown>;

function exaData(text: string): ExaJson | null {
  /* SSE body: one JSON object per "data:" line; the last one carries
     the id-matched result. */
  let out: ExaJson | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      out = JSON.parse(t.slice(5).trim()) as ExaJson;
    } catch {
      /* keep the last parseable one */
    }
  }
  return out;
}

async function exaPost(
  body: unknown,
  sessionId?: string | null
): Promise<{ status: number; session: string | null; data: ExaJson | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(EXA_MCP, { method: "POST", headers, body: JSON.stringify(body) });
  const text = res.status === 202 ? "" : await res.text();
  return {
    status: res.status,
    /* The session id rides the mcp-session-id response header. */
    session: res.headers.get("mcp-session-id"),
    data: res.status === 202 ? null : exaData(text),
  };
}

async function exaEnsureSession(): Promise<void> {
  if (exaSession) return;
  const init = await exaPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "lobsterbrowse", version: "0.8.0" },
    },
  });
  if (!init.session) throw new Error("Exa MCP did not open a session");
  exaSession = init.session;
  await exaPost({ jsonrpc: "2.0", method: "notifications/initialized" }, exaSession);
}

async function exaSearchCall(query: string): Promise<AiSource[]> {
  const call = await exaPost(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query, numResults: 5 } },
    },
    exaSession
  );
  const r = (call.data && call.data.result) as
    | { content?: { text?: string }[]; isError?: boolean }
    | undefined;
  if (call.status !== 200 || !r) throw new Error("Exa search failed (HTTP " + call.status + ")");
  if (r.isError) throw new Error("Exa search returned an error");
  return parseExaResults((r.content ?? []).map((c) => c.text ?? "").join(""));
}

/* ponytail: the tool returns one text blob ("Title:/URL:/Highlights:");
   a structured content field would remove this parser. */
function parseExaResults(text: string): AiSource[] {
  const out: AiSource[] = [];
  for (const block of text.split(/\n---\n?/)) {
    const url = block.match(/\bURL: (\S+)/);
    if (!url) continue;
    const title = (block.match(/\bTitle: (.*)/) ?? [])[1] ?? "";
    const hl = block.split(/Highlights:\n?/)[1] ?? "";
    out.push({ title: title.trim() || url[1], url: url[1], snippet: hl.trim().slice(0, 400) });
  }
  return out;
}

export async function aiSearch(query: string): Promise<AiSource[]> {
  if (isMocked()) return MOCK_SOURCES;
  await exaEnsureSession();
  try {
    return await exaSearchCall(query);
  } catch {
    /* An expired session is the expected failure: one fresh
       handshake, one retry, then give up honestly. */
    exaSession = null;
    await exaEnsureSession();
    return await exaSearchCall(query);
  }
}

/* ---- Cloudflare Workers AI streaming client (via the server
   proxy) ---- */

export type ChatContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/* Model-invoked web search (Cloudflare function calling): the tool
   schema the model sees, and the call it streams back. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the public web for current information.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
} as const;

export type StreamEvent =
  | { type: "thinking" | "text"; text: string }
  | { type: "quota"; remaining: number }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "finish"; reason: string };

/* Rate-limit refusals carry their own class so the UI offers the
   Try again action only where a retry can actually help. */
export class RateLimitError extends Error {}

async function aiErrText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const v = JSON.parse(text) as { error?: unknown };
    if (typeof v.error === "string" && v.error) return v.error;
  } catch {
    /* not JSON: fall through */
  }
  return "AI service error (HTTP " + res.status + ")" + (text ? " - " + text.slice(0, 200) : "");
}

export async function* streamChat(opts: {
  model: string;
  messages: ChatMsg[];
  thinking: boolean;
  tools?: unknown[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  if (isMocked()) {
    yield* mockStream(opts.thinking);
    return;
  }
  const res = await fetch("/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      thinking: opts.thinking,
      tools: opts.tools,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await aiErrText(res);
    throw res.status === 429 ? new RateLimitError(detail) : new Error(detail);
  }
  const remaining = Number(res.headers.get("x-lb-ai-remaining"));
  if (Number.isFinite(remaining) && remaining >= 0) yield { type: "quota", remaining };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  /* Function calling: Cloudflare streams tool_calls as indexed
     deltas (arguments arrive in fragments) and closes the round
     with finish_reason "tool_calls". */
  const calls: Record<number, ToolCall> = {};
  let finish = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      let evt: {
        choices?: {
          delta?: {
            content?: unknown;
            reasoning_content?: unknown;
            tool_calls?: { index?: number; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
          };
          finish_reason?: unknown;
        }[];
      };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = evt.choices?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finish = choice.finish_reason;
      }
      const delta = choice.delta;
      if (!delta) continue;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const slot = (calls[idx] ??= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
          if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
          const fn = tc.function;
          if (fn && typeof fn.name === "string" && fn.name) slot.function.name = fn.name;
          if (fn && typeof fn.arguments === "string") slot.function.arguments += fn.arguments;
        }
      }
      /* gpt-oss and qwen stream their reasoning before the answer;
      reasoning_content is the OpenAI-compatible field Cloudflare
      uses for it. */
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        yield { type: "thinking", text: delta.reasoning_content };
      }
      const c = delta.content;
      if (typeof c === "string") {
        if (c) yield { type: "text", text: c };
      } else if (Array.isArray(c)) {
        /* Content may arrive as typed chunks: thinking + text. */
        for (const part of c) {
          const p = part as { type?: string; thinking?: string; text?: string };
          if (p.type === "thinking" && p.thinking) yield { type: "thinking", text: p.thinking };
          else if (p.type === "text" && p.text) yield { type: "text", text: p.text };
        }
      }
    }
  }
  const list = Object.keys(calls)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => calls[k])
    .filter((c): c is ToolCall => Boolean(c));
  if (list.length) yield { type: "tool_calls", calls: list };
  yield { type: "finish", reason: finish || "stop" };
}
