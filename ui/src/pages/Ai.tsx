import { useEffect, useRef, useState } from "react";
import {
  AI_MODELS,
  aiSearch,
  loadModelId,
  needsThinking,
  saveChat,
  saveModelId,
  streamChat,
  WEB_SEARCH_TOOL,
  RateLimitError,
  type AiModel,
  type AiMsg,
  type ChatContent,
  type ChatMsg,
  type AiSource,
  type ToolCall,
} from "../ai/aiStore";
import { Markdown } from "../ai/Markdown";
import { ToolRow } from "../ai/ToolRow";

/* AI mode (beta-only). The Cloudflare Workers AI key lives on the
   server: sends go to this origin's /ai/chat proxy, which enforces
   the rate limit (50 messages per rolling 6 h) and reports the
   remaining count in the x-lb-ai-remaining header. Web search is
   model-invoked: the model streams web_search tool calls and the
   page runs the keyless Exa MCP search for it. Chats persist
   encrypted in IndexedDB with a
   non-exportable key. Errors surface through the M3E snackbar; AI
   failures carry a Try again action that replays the failed turn.
   Provider marks (OpenAI, Qwen) live on the model entries in
   aiStore.ts. */

const QUOTA_MAX = 50;

type Phase = "idle" | "searching" | "thinking" | "streaming";

interface Attached {
  name: string;
  kind: "text" | "image";
  text?: string;
  dataUrl?: string;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.readAsDataURL(f);
  });
}

/* The notification service (M3E snackbar, same one App uses). AI
   failures pass a retry callback so the Try again action replays
   the failed turn; informational notices open without an action. */
function toast(text: string, retry?: () => void): void {
  if (typeof M3eSnackbar === "undefined" || !M3eSnackbar) return;
  if (retry) {
    M3eSnackbar.open(text, "Try again", { actionCallback: retry, duration: 8000 });
  } else {
    M3eSnackbar.open(text, { duration: 6000 });
  }
}

/* Model picker: the 21st.dev model-picker pattern (pill trigger +
   popover + checkmark) hand-ported onto M3E tokens. Entries are the
   models the server proxy actually serves; the mark is the model
   provider's official logo at text height, and the parameter count
   is the one bold element in the row. Selecting an entry is real:
   it persists (loadModelId/saveModelId) and the next send uses it.
   The popover stays mounted so its open/close transition can play
   in both directions (theme.css .lb-ai-mp-pop / .lb-open). */
function ModelPicker({ value, onChange }: { value: AiModel; onChange: (m: AiModel) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="lb-ai-mp" ref={wrapRef}>
      <button
        type="button"
        className="lb-ai-mp-btn"
        aria-label="Select model"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lb-ai-mark" aria-hidden={true} dangerouslySetInnerHTML={{ __html: value.mark }} />
        <span className="lb-ai-mp-name">{value.name} {value.version}</span>
        <span className="lb-ai-mp-params">{value.params}</span>
        <svg className="lb-ai-mp-chev" viewBox="0 0 24 24" aria-hidden={true}>
          <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div
        className={"lb-ai-mp-pop" + (open ? " lb-open" : "")}
        role="dialog"
        aria-label="Select a model"
        aria-hidden={!open}
      >
        {AI_MODELS.map((m) => (
          <button
            key={m.id}
            type="button"
            className="lb-ai-mp-opt"
            onClick={() => {
              onChange(m);
              setOpen(false);
            }}
          >
            <span className="lb-ai-mark" aria-hidden={true} dangerouslySetInnerHTML={{ __html: m.mark }} />
            <span className="lb-ai-model-item">
              <span className="lb-ai-model-name">{m.name} <span className="lb-ai-model-ver">{m.version}</span></span>
              <span className="lb-ai-model-params">{m.params}</span>
              <span className="lb-ai-model-note">{m.note}</span>
            </span>
            {m.id === value.id && (
              <span className="lb-ai-mp-check">
                <m3e-icon name="check" aria-hidden={true} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AiPage() {
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AiMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  /* Remaining server quota; null until the first send answers. */
  const [quota, setQuota] = useState<number | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);

  const barRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* The selected model persists in localStorage; the picker changes
  it and the next send uses it. */
  const [model, setModel] = useState<AiModel>(
    () => AI_MODELS.find((m) => m.id === loadModelId()) ?? AI_MODELS[0]
  );
  const pickModel = (m: AiModel) => {
    setModel(m);
    saveModelId(m.id);
  };

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

  async function onFiles(list: FileList | null) {
    if (!list) return;
    const max = 5 - attached.length;
    const picked = Array.from(list).slice(0, max);
    const out: Attached[] = [];
    for (const f of picked) {
      if (f.size > 4 * 1024 * 1024) {
        toast(f.name + " is over the 4 MB limit.");
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

  async function send(retry?: { text: string; files: Attached[] }) {
    const text = retry ? retry.text : draft.trim();
    const files = retry ? retry.files : attached;
    if (!text || busy) return;
    const before = messages.length;

    const userMsg: AiMsg = { role: "user", text, files: files.map((f) => f.name) };
    const withFiles = files
      .filter((f) => f.kind === "text")
      .reduce((acc, f) => acc + "\n\n[Attached file: " + f.name + "]\n" + f.text, text);
    setAttached([]);
    setDraft("");
    setMessages((m) => [...m, userMsg]);
    setBusy(true);
    setPhase("streaming");

    /* Image parts are vision-model-only on Cloudflare: an image
       turn re-routes to the vision model for that turn (noted on
       the reply). */
    const hasImage = files.some((f) => f.kind === "image");
    const turnModel =
      hasImage && !model.vision ? (AI_MODELS.find((m) => m.vision) ?? model) : model;
    const thinking = turnModel.thinking && needsThinking(withFiles);
    /* Web search is model-invoked (function calling): the system
       prompt teaches the tool; the loop below runs the calls the
       model streams back. */
    const sys =
      "You are the assistant inside LobsterBrowse, a private web proxy browser. Be concise and accurate. " +
      "You can call the web_search tool whenever the question benefits from current web information " +
      "(news, prices, releases, anything recent or uncertain); answer citing the results by number. " +
      "Skip the tool when the answer needs no web lookup.";
    const parts: ChatContent = [{ type: "text", text: withFiles }];
    for (const f of files)
      if (f.kind === "image" && f.dataUrl) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });

    /* ponytail: history collapses to plain text; images only ride the
       turn they were attached to. */
    const history: ChatMsg[] = messages.map((m) => ({ role: m.role, content: m.text }));
    const apiMessages: ChatMsg[] = [
      { role: "system", content: sys },
      ...history,
      { role: "user", content: parts },
    ];

    setMessages((m) => [
      ...m,
      { role: "assistant", text: "", model: turnModel.id },
    ]);
    setPhase(thinking ? "thinking" : "streaming");
    let acc = "";
    let thinkAcc = "";
    let sources: AiSource[] | undefined;
    const flush = () =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          text: acc,
          thinking: thinkAcc || undefined,
          sources,
        };
        return copy;
      });
    let ok = false;
    try {
      for (let round = 0; round < 3; round++) {
        let calls: ToolCall[] = [];
        let finish = "stop";
        for await (const ev of streamChat({
          model: turnModel.id,
          messages: apiMessages,
          thinking,
          tools: [WEB_SEARCH_TOOL],
        })) {
          if (ev.type === "quota") {
            setQuota(ev.remaining);
          } else if (ev.type === "thinking") {
            thinkAcc += ev.text;
            setPhase("thinking");
          } else if (ev.type === "text") {
            acc += ev.text;
            setPhase("streaming");
          } else if (ev.type === "tool_calls") {
            calls = ev.calls;
          } else if (ev.type === "finish") {
            finish = ev.reason;
          }
          flush();
        }
        if (finish !== "tool_calls" || !calls.length) break;
        /* The model invoked web_search: replay its calls, run the
        keyless Exa search, and answer with the tool results. */
        apiMessages.push({ role: "assistant", content: "", tool_calls: calls });
        for (const call of calls) {
          let q = text;
          try {
            q = String(JSON.parse(call.function.arguments).query ?? text);
          } catch {
            /* malformed arguments: fall back to the turn text */
          }
          setPhase("searching");
          try {
            const found = await aiSearch(q);
            sources = [...(sources ?? []), ...found];
            apiMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(found),
            });
          } catch (e) {
            toast("Web search failed: " + msg(e) + " Answering without it.");
            apiMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "web search failed",
            });
          }
          flush();
        }
      }
      if (!acc && !thinkAcc) throw new Error("The model returned an empty response.");
      ok = true;
    } catch (e) {
      /* Roll the failed turn back so the notification's Try again
         action replays it cleanly. */
      setMessages((m) => m.slice(0, before));
      const rl = e instanceof RateLimitError;
      toast(
        rl ? msg(e) : "AI error: " + msg(e),
        rl ? undefined : () => {
          void send({ text, files });
        }
      );
    } finally {
      setBusy(false);
      setPhase("idle");
      /* Persist the turn; a storage failure never loses it from view. */
      if (ok) {
        try {
          const all = [
            ...messages,
            userMsg,
            {
              role: "assistant" as const,
              text: acc,
              thinking: thinkAcc || undefined,
              model: turnModel.id,
              sources,
            },
          ];
          const id = await saveChat({
            id: currentId ?? undefined,
            title: text.slice(0, 48),
            messages: all,
            updated: Date.now(),
          });
          setCurrentId(id);
        } catch {
          toast("Chat could not be saved locally.");
        }
      }
    }
  }

  const quotaUsed = quota === null ? 0 : QUOTA_MAX - quota;

  return (
    <div className="lb-ai">
      <div className="lb-ai-msgs" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="lb-ai-hello">How can I help you today?</div>
        )}
        {messages.map((m, i) => {
          const last = i === messages.length - 1;
          return (
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
              {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                <ToolRow label="Searching the web" doneLabel="Searched the web" active={last && busy && phase === "searching"}>
                  <div className="lb-ai-sources">
                    {m.sources.map((s, j) => (
                      <a key={j} className="lb-ai-src" href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    ))}
                  </div>
                </ToolRow>
              )}
              {m.role === "assistant" && m.thinking && (
                <ToolRow label="Thinking" doneLabel="Thought" active={last && busy && phase === "thinking"}>
                  <pre className="lb-ai-think-pre">{m.thinking}</pre>
                </ToolRow>
              )}
              {m.role === "user" && m.text && <div className="lb-ai-bubble">{m.text}</div>}
              {m.role === "assistant" && m.text && (
                <div className="lb-ai-bubble lb-ai-answer">
                  <Markdown text={m.text} />
                </div>
              )}
              {m.role === "assistant" && last && busy && phase === "streaming" && !m.text && !m.thinking && (
                <div className="lb-ai-tool">
                  <span className="lb-ai-tool-label lb-ai-shimmer" role="status">
                    Responding
                  </span>
                </div>
              )}
            </div>
          );
        })}
        {busy && phase === "searching" && (
          <div className="lb-ai-msg lb-ai-assistant">
            <div className="lb-ai-tool">
              <span className="lb-ai-tool-label lb-ai-shimmer" role="status">
                Searching the web
              </span>
            </div>
          </div>
        )}
      </div>

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
            placeholder="Ask Anything"
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
        <button type="button" className="lb-ai-send" aria-label="Send" onClick={() => void send()}>
          <span className="lb-ai-send-seg lb-ai-send-a">
            <m3e-icon name="arrow_forward" aria-hidden={true} />
          </span>
          <span className="lb-ai-send-seg lb-ai-send-b">Send</span>
        </button>
      </div>

      <div className="lb-ai-under">
        <ModelPicker value={model} onChange={pickModel} />
        <span
          className={"lb-ai-quota" + (quota !== null && quota <= 0 ? " lb-ai-quota-out" : "")}
          title={quota !== null ? quota + " of " + QUOTA_MAX + " messages left in the current 6 hour window" : undefined}
        >
          {quotaUsed}/{QUOTA_MAX}
        </span>
      </div>
    </div>
  );
}
