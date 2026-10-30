import { useEffect, useRef, useState } from "react";
import {
  AI_MODELS,
  aiSearch,
  listChats,
  loadKeys,
  loadModelId,
  needsThinking,
  quotaResetInMs,
  recordUse,
  remainingQuota,
  saveChat,
  saveKeys,
  saveModelId,
  streamMistral,
  type AiChat,
  type AiKeys,
  type AiMsg,
  type MistralContent,
  type MistralMsg,
  type AiSource,
} from "../ai/aiStore";
import { ParticleHero } from "../ai/ParticleHero";
import neurologySvg from "@material-symbols/svg-400/outlined/neurology.svg?raw";

/* AI mode (beta-only). Fully client-side: the user's API keys live in
   localStorage and calls go straight from the browser to Mistral and
   Tavily. Chats persist encrypted in IndexedDB (non-exportable key).
   Rate limit: 50 messages per 6 hours, sliding window. */

const PRESETS = [
  "What should we look into today?",
  "Ask anything. Your questions stay on this device.",
  "No accounts, no trails. Just answers.",
  "Every question opens a door.",
  "Curiosity, privately served.",
  "What is on your mind?",
  "The web has answers. You keep the identity.",
  "Ask the web without handing over your name.",
  "Think out loud. Something is listening.",
  "Where shall we wander today?",
];

/* Stylized Mistral mark (the parent company of every listed model). */
const MISTRAL_MARK =
  '<svg viewBox="0 0 24 22" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="10" height="5" fill="#FAFF00"/><rect x="13" y="1" width="10" height="5" fill="#FAFF00"/><rect x="1" y="8" width="10" height="5" fill="#FF9D00"/><rect x="13" y="8" width="10" height="5" fill="#FF9D00"/><rect x="7" y="15" width="10" height="5" fill="#FF4B00"/></svg>';

const QUOTA_MAX = 50;

type DialogEl = HTMLElement & { show: () => Promise<void>; hide: () => Promise<void> };
interface Attached {
  name: string;
  kind: "text" | "image";
  text?: string;
  dataUrl?: string;
}
type Phase = "idle" | "searching" | "thinking" | "streaming";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtReset(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m < 60 ? m + " min" : Math.ceil(m / 60) + " h";
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.readAsDataURL(f);
  });
}

export default function AiPage() {
  const [sentence] = useState(() => PRESETS[Math.floor(Math.random() * PRESETS.length)]);
  const [model, setModel] = useState(loadModelId);
  const [keys, setKeys] = useState<AiKeys>(loadKeys);
  const [chats, setChats] = useState<AiChat[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AiMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [quota, setQuota] = useState(remainingQuota);
  const [attached, setAttached] = useState<Attached[]>([]);

  const barRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const keysDialogRef = useRef<DialogEl | null>(null);
  const mistralKeyRef = useRef<HTMLInputElement | null>(null);
  const tavilyKeyRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const currentModel = AI_MODELS.find((m) => m.id === model) ?? AI_MODELS[0];
  const searchOn = Boolean(keys.tavily);

  useEffect(() => {
    let alive = true;
    listChats()
      .then((all) => {
        if (alive) setChats(all);
      })
      .catch(() => setError("Stored chats could not be read."));
    return () => {
      alive = false;
    };
  }, []);

  /* The search bar's own clear (X) event bypasses React's value
     tracker; mirror the Home.tsx pattern. */
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onClear = () => setDraft("");
    bar.addEventListener("clear", onClear);
    return () => bar.removeEventListener("clear", onClear);
  }, []);

  /* Keep the newest message in view while it streams. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || phase !== "streaming") el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  function newChat() {
    setCurrentId(null);
    setMessages([]);
    setAttached([]);
    setError("");
    setNotice("");
    inputRef.current?.focus();
  }

  function openChat(c: AiChat) {
    setCurrentId(c.id ?? null);
    setMessages(c.messages);
    setAttached([]);
    setError("");
  }

  async function onFiles(list: FileList | null) {
    if (!list) return;
    const max = 5 - attached.length;
    const picked = Array.from(list).slice(0, max);
    const out: Attached[] = [];
    for (const f of picked) {
      if (f.size > 4 * 1024 * 1024) {
        setError(f.name + " is over the 4 MB limit.");
        continue;
      }
      if (
        f.type.startsWith("text/") ||
        /\.(txt|md|json|csv|ts|tsx|js|mjs|py|rs|toml|html|css|xml|yml|yaml|log)$/i.test(f.name)
      ) {
        out.push({ name: f.name, kind: "text", text: (await f.text()).slice(0, 60000) });
      } else if (f.type.startsWith("image/")) {
        out.push({ name: f.name, kind: "image", dataUrl: await readAsDataUrl(f) });
      }
    }
    if (out.length) setAttached((a) => [...a, ...out].slice(0, 5));
  }

  function openKeys() {
    const dlg = keysDialogRef.current;
    if (!dlg) return;
    if (mistralKeyRef.current) mistralKeyRef.current.value = keys.mistral;
    if (tavilyKeyRef.current) tavilyKeyRef.current.value = keys.tavily;
    void dlg.show();
  }

  function storeKeys() {
    const next: AiKeys = {
      mistral: (mistralKeyRef.current?.value ?? "").trim(),
      tavily: (tavilyKeyRef.current?.value ?? "").trim(),
    };
    saveKeys(next);
    setKeys(next);
    void keysDialogRef.current?.hide();
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const k = loadKeys();
    if (!k.mistral) {
      openKeys();
      setError("Add a Mistral API key first.");
      return;
    }
    if (remainingQuota() <= 0) {
      setError("Rate limit reached. Try again in " + fmtReset(quotaResetInMs()) + ".");
      return;
    }
    setError("");
    setNotice("");

    const files = attached;
    const userMsg: AiMsg = { role: "user", text, files: files.map((f) => f.name) };
    const withFiles = files
      .filter((f) => f.kind === "text")
      .reduce((acc, f) => acc + "\n\n[Attached file: " + f.name + "]\n" + f.text, text);
    setAttached([]);
    setDraft("");
    setMessages((m) => [...m, userMsg]);
    recordUse();
    setQuota(remainingQuota());

    /* Always-on search: runs before the model call whenever a key
       exists; a search failure never blocks the answer. */
    let sources: AiSource[] | undefined;
    if (k.tavily) {
      setPhase("searching");
      try {
        sources = await aiSearch(text, k.tavily);
      } catch (e) {
        setNotice("Web search failed: " + msg(e));
      }
    }

    const thinking = currentModel.thinking && needsThinking(withFiles);
    const sys =
      "You are the assistant inside LobsterBrowse, a private web proxy browser. Be concise and accurate. " +
      (sources?.length
        ? "Ground your answer in the provided web search results and cite them by number."
        : "");
    const searchBlock = sources?.length
      ? "\n\nWeb search results for the latest user message (retrieved just now):\n" +
        sources.map((s, i) => "[" + (i + 1) + "] " + s.title + " - " + s.url + "\n" + s.snippet).join("\n\n")
      : "";
    const parts: MistralContent = [{ type: "text", text: withFiles + searchBlock }];
    for (const f of files)
      if (f.kind === "image" && f.dataUrl) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });

    /* ponytail: history collapses to plain text; images only ride the
       turn they were attached to. */
    const history: MistralMsg[] = messages.map((m) => ({ role: m.role, content: m.text }));
    const apiMessages: MistralMsg[] = [
      { role: "system", content: sys },
      ...history,
      { role: "user", content: parts },
    ];

    const asst: AiMsg = { role: "assistant", text: "", model: currentModel.id, sources };
    setMessages((m) => [...m, asst]);
    setPhase(thinking ? "thinking" : "streaming");
    setBusy(true);
    let acc = "";
    let thinkAcc = "";
    const flush = () =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: acc, thinking: thinkAcc || undefined };
        return copy;
      });
    try {
      for await (const ev of streamMistral({
        key: k.mistral,
        model: currentModel.id,
        messages: apiMessages,
        thinking,
      })) {
        if (ev.type === "thinking") {
          thinkAcc += ev.text;
        } else {
          acc += ev.text;
          setPhase("streaming");
        }
        flush();
      }
      if (!acc && !thinkAcc) setError("The model returned an empty response.");
    } catch (e) {
      setError(msg(e));
      flush();
    } finally {
      setBusy(false);
      setPhase("idle");
      /* Persist the turn; a storage failure never loses it from view. */
      try {
        const title =
          messages.length === 0
            ? text.slice(0, 48)
            : (chats.find((c) => c.id === currentId)?.title ?? text.slice(0, 48));
        const all = [
          ...messages,
          userMsg,
          { ...asst, text: acc, thinking: thinkAcc || undefined },
        ];
        const id = await saveChat({ id: currentId ?? undefined, title, messages: all, updated: Date.now() });
        setCurrentId(id);
        setChats(await listChats());
      } catch {
        setNotice("Chat could not be saved locally.");
      }
    }
  }

  return (
    <div className="lb-ai">
      <div className="lb-ai-head">
        <m3e-menu-trigger for="lb-ai-chats-menu">
          <m3e-icon-button aria-label="Chats">
            <m3e-icon name="history" aria-hidden={true} />
          </m3e-icon-button>
        </m3e-menu-trigger>
        <m3e-menu id="lb-ai-chats-menu">
          {chats.length === 0 && <m3e-menu-item disabled={""}>No saved chats yet</m3e-menu-item>}
          {chats.map((c) => (
            <m3e-menu-item key={c.id} onClick={() => openChat(c)}>
              {c.title || "Untitled"}
            </m3e-menu-item>
          ))}
        </m3e-menu>
        <m3e-button variant="text" onClick={newChat}>
          New chat
        </m3e-button>
        <span className="lb-ai-sp"></span>
        <m3e-menu-trigger for="lb-ai-model-menu">
          <m3e-button variant="text">
            <span
              slot="icon"
              className="lb-ai-mark"
              aria-hidden={true}
              dangerouslySetInnerHTML={{ __html: MISTRAL_MARK }}
            />
            {currentModel.name}
          </m3e-button>
        </m3e-menu-trigger>
        <m3e-menu id="lb-ai-model-menu">
          {AI_MODELS.map((m) => (
            <m3e-menu-item-radio
              key={m.id}
              checked={m.id === model ? "" : undefined}
              onClick={() => {
                setModel(m.id);
                saveModelId(m.id);
              }}
            >
              <span
                slot="icon"
                className="lb-ai-mark"
                aria-hidden={true}
                dangerouslySetInnerHTML={{ __html: MISTRAL_MARK }}
              />
              <span className="lb-ai-model-item">
                <span className="lb-ai-model-name">{m.name}</span>
                <span className="lb-ai-model-params">{m.params}</span>
                <span className="lb-ai-model-note">{m.note}</span>
              </span>
            </m3e-menu-item-radio>
          ))}
        </m3e-menu>
        <m3e-icon-button aria-label="API keys" onClick={openKeys}>
          <m3e-icon name="settings" aria-hidden={true} />
        </m3e-icon-button>
        <span
          className={"lb-ai-quota" + (quota === 0 ? " lb-ai-quota-out" : "")}
          title={"Resets in " + fmtReset(quotaResetInMs())}
        >
          {QUOTA_MAX - quota}/{QUOTA_MAX}
        </span>
      </div>

      <ParticleHero text={sentence} />

      <div className="lb-ai-msgs" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="lb-ai-empty">
            <p>Ask anything. {searchOn ? "Web search is on." : "Add a Tavily key to turn web search on."}</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"lb-ai-msg lb-ai-" + m.role}>
            {m.files && m.files.length > 0 && (
              <div className="lb-ai-files">
                {m.files.map((n, j) => (
                  <span key={j} className="lb-ai-file-chip">
                    {n}
                  </span>
                ))}
              </div>
            )}
            {m.thinking && (
              <details className="lb-ai-think">
                <summary>Reasoning</summary>
                <pre>{m.thinking}</pre>
              </details>
            )}
            {m.text && <div className="lb-ai-bubble">{m.text}</div>}
            {m.sources && m.sources.length > 0 && (
              <div className="lb-ai-sources">
                {m.sources.map((s, j) => (
                  <a key={j} className="lb-ai-src" href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && phase !== "streaming" && (
          <div className="lb-ai-msg lb-ai-assistant">
            <div
              className={"lb-ai-morph lb-ai-morph-" + (phase === "searching" ? "fast" : "slow")}
              role="status"
              aria-label={phase === "searching" ? "Searching the web" : "Thinking"}
            ></div>
          </div>
        )}
      </div>

      {(error || notice) && (
        <div className="lb-ai-err" role="alert">
          {error || notice}
        </div>
      )}

      {attached.length > 0 && (
        <div className="lb-ai-att">
          {attached.map((f, i) => (
            <span key={i} className="lb-ai-file-chip">
              {f.name}
              <button
                className="lb-ai-file-x"
                aria-label={"Remove " + f.name}
                onClick={() => setAttached((a) => a.filter((_, j) => j !== i))}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="lb-ai-bar">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <m3e-search-bar clearable {...{ ref: barRef }}>
          <m3e-icon-button slot="leading" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
            <m3e-icon name="add" aria-hidden={true} />
          </m3e-icon-button>
          <input
            slot="input"
            ref={inputRef}
            aria-label="Message the assistant"
            placeholder="Ask anything"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </m3e-search-bar>
        <m3e-icon-button aria-label="Send" onClick={() => void send()}>
          <m3e-icon name="arrow_forward" aria-hidden={true} />
        </m3e-icon-button>
      </div>

      <m3e-dialog id="lb-ai-keys" dismissible close-label="Close" {...{ ref: keysDialogRef }}>
        <div slot="header">API keys</div>
        <p className="lb-ai-keys-note">
          Keys are stored only in this browser and are sent directly from your device to the provider.
          Free keys: console.mistral.ai and app.tavily.com.
        </p>
        <label className="lb-ai-key-field">
          <span>Mistral API key</span>
          <input ref={mistralKeyRef} type="password" autoComplete="off" placeholder="Mistral API key" />
        </label>
        <label className="lb-ai-key-field">
          <span>Tavily search key, optional</span>
          <input ref={tavilyKeyRef} type="password" autoComplete="off" placeholder="Tavily key" />
        </label>
        <div slot="actions">
          <m3e-button variant="text" onClick={() => void keysDialogRef.current?.hide()}>
            Close
          </m3e-button>
          <m3e-button variant="filled" onClick={storeKeys}>
            Save
          </m3e-button>
        </div>
      </m3e-dialog>
    </div>
  );
}
