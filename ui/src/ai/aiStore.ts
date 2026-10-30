/* AI mode storage and provider clients.
   Everything runs client-side in the browser: the LB server is not
   involved in any AI call. Chats are encrypted at rest with a
   non-exportable AES-GCM key held in IndexedDB. By design there is no
   key export: losing the browser profile loses the chats.
   The rate limit is a UX quota, not a security control: clearing site
   data resets it. */

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
  { id: "mistral-small-latest", name: "Mistral Small", params: "119B total / 6B active MoE, 256k context", note: "Default. Multimodal, dynamic thinking.", thinking: true },
  { id: "mistral-medium-latest", name: "Mistral Medium", params: "Undisclosed, 128k context", note: "Strongest reasoning tier.", thinking: true },
  { id: "mistral-large-latest", name: "Mistral Large", params: "Undisclosed, 256k context", note: "Flagship dense model, no thinking mode.", thinking: false },
  { id: "ministral-8b-latest", name: "Ministral 8B", params: "8B dense, 128k context", note: "Light and fast.", thinking: false },
  { id: "codestral-latest", name: "Codestral", params: "24B dense, 256k context", note: "Code specialist.", thinking: false },
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
  tavily: string;
}

export function loadKeys(): AiKeys {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_KEYS) || "{}") as Partial<AiKeys>;
    return {
      mistral: typeof v.mistral === "string" ? v.mistral : "",
      tavily: typeof v.tavily === "string" ? v.tavily : "",
    };
  } catch {
    return { mistral: "", tavily: "" };
  }
}

export function saveKeys(keys: AiKeys): void {
  try {
    localStorage.setItem(KEY_KEYS, JSON.stringify(keys));
  } catch {
    /* ignore */
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

/* ---- web search: Tavily (CORS-open from the browser, free tier) ---- */

export async function aiSearch(query: string, key: string): Promise<AiSource[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ query, max_results: 5 }),
  });
  if (!res.ok) throw new Error("Search failed (Tavily " + res.status + ")");
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({
    title: r.title || r.url || "Result",
    url: r.url || "",
    snippet: (r.content || "").slice(0, 400),
  }));
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
