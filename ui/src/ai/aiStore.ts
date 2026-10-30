/* AI mode storage and provider clients.
   Everything runs client-side in the browser: the LB server is not
   involved in any AI call. Chats are encrypted at rest with a
   non-exportable AES-GCM key held in IndexedDB. By design there is no
   key export: losing the browser profile loses the chats.
   The rate limit is a UX quota, not a security control: clearing site
   data resets it. */

import { loadDebugOverrides } from "../debug.ts";

const KEY_MODEL = "lobsterbrowse-ai-model";
const KEY_KEYS = "lobsterbrowse-ai-keys";
const KEY_USES = "lobsterbrowse-ai-usage";

export interface AiModel {
  id: string;
  name: string;
  params: string;
  note: string;
  thinking: boolean;
}

/* Parameter lines stay honest: undisclosed stays undisclosed. */
export const AI_MODELS: AiModel[] = [
  { id: "mistral-small-latest", name: "Mistral Small", params: "119B total / 6B active MoE, 256k context", note: "Multimodal, dynamic thinking.", thinking: true },
];

export function loadModelId(): string {
  try {
    const v = localStorage.getItem(KEY_MODEL);
    return v && AI_MODELS.some((m) => m.id === v) ? v : "mistral-small-latest";
  } catch {
    return "mistral-small-latest";
  }
}

export function saveModelId(id: string): void {
  try {
    localStorage.setItem(KEY_MODEL, id);
  } catch {
    /* ignore */
  }
}

export interface AiKeys {
  mistral: string;
}

export function loadKeys(): AiKeys {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_KEYS) || "{}") as Partial<AiKeys>;
    return { mistral: typeof v.mistral === "string" ? v.mistral : "" };
  } catch {
    return { mistral: "" };
  }
}

/* ---- rate limit: 50 messages per sliding 6 hour window ---- */

const QUOTA = 50;
const WINDOW_MS = 6 * 60 * 60 * 1000;

function pruneUses(now: number): number[] {
  let uses: number[] = [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY_USES) || "[]");
    if (Array.isArray(v)) uses = v.filter((n) => typeof n === "number" && now - n < WINDOW_MS);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(KEY_USES, JSON.stringify(uses));
  } catch {
    /* ignore */
  }
  return uses;
}

export function remainingQuota(): number {
  return Math.max(0, QUOTA - pruneUses(Date.now()).length);
}

export function quotaResetInMs(): number {
  const uses = pruneUses(Date.now());
  return uses.length ? WINDOW_MS - (Date.now() - uses[0]) : 0;
}

export function recordUse(): void {
  const now = Date.now();
  const uses = pruneUses(now);
  uses.push(now);
  try {
    localStorage.setItem(KEY_USES, JSON.stringify(uses));
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
    "This is a mock answer produced locally by the debug menu. No Mistral API call and no Exa search " +
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

/* ---- Mistral streaming client ---- */

export type MistralContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface MistralMsg {
  role: "system" | "user" | "assistant";
  content: MistralContent;
}

export interface StreamEvent {
  type: "thinking" | "text";
  text: string;
}

export async function* streamMistral(opts: {
  key: string;
  model: string;
  messages: MistralMsg[];
  thinking: boolean;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  if (isMocked()) {
    yield* mockStream(opts.thinking);
    return;
  }
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.key },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      /* Dynamic thinking: high only when the heuristic fired. */
      reasoning_effort: opts.thinking ? "high" : "none",
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error("Mistral API " + res.status + (detail ? " - " + detail.slice(0, 200) : ""));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
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
      if (payload === "[DONE]") return;
      let evt: { choices?: { delta?: { content?: unknown } }[] };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = evt.choices?.[0]?.delta;
      if (!delta) continue;
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
}
