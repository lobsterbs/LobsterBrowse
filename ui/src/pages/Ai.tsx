import { useEffect, useRef, useState } from "react";
import {
  AI_MODELS,
  aiSearch,
  needsThinking,
  saveChat,
  streamMistral,
  RateLimitError,
  type AiMsg,
  type MistralContent,
  type MistralMsg,
  type AiSource,
} from "../ai/aiStore";
import { Markdown } from "../ai/Markdown";
import { ToolRow } from "../ai/ToolRow";

/* AI mode (beta-only). The Mistral key lives on the server: sends go
   to this origin's /ai/chat proxy, which enforces the rate limit
   (50 messages per rolling 6 h) and reports the remaining count in
   the x-lb-ai-remaining header. Web search is keyless (Exa MCP).
   Chats persist encrypted in IndexedDB with a non-exportable key.
   Errors surface through the M3E snackbar; AI failures carry a
   Try again action that replays the failed turn. */

/* Official Mistral mark (the model's parent company): the mark-only
   crop of the docs.mistral.ai logo asset, exact official geometry. */
const MISTRAL_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 47 170 122"><g transform="matrix(.796709 0 0 .796709 61.562988 176.05127)"><path d="M-46.307-161.245h30.303v30.303h-30.303zm121.212 0h30.303v30.303H74.905z" fill="gold"/><path d="M-46.307-130.942h60.606v30.303h-60.606zm90.909 0h60.606v30.303H44.602z" fill="#ffaf00"/><path d="M-46.307-100.639h151.515v30.303H-46.307z" fill="#ff8205"/><path d="M-46.307-70.336h30.303v30.303h-30.303zm60.606 0h30.303v30.303H14.299zm60.606 0h30.303v30.303H74.905z" fill="#fa500f"/><path d="M-76.61-40.033h90.909V-9.73H-76.61zm121.212 0h90.909V-9.73H44.602z" fill="#e10500"/></g></svg>';

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
   models the server proxy actually serves; the mark is the parent
   company's official logo at text height, and the parameter count
   is the one bold element in the row. */
function ModelPicker() {
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
  const active = AI_MODELS[0];
  return (
    <div className="lb-ai-mp" ref={wrapRef}>
      <button
        type="button"
        className="lb-ai-mp-btn"
        aria-label="Select model"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lb-ai-mark" aria-hidden={true} dangerouslySetInnerHTML={{ __html: MISTRAL_MARK }} />
        <span className="lb-ai-mp-name">{active.name} {active.version}</span>
        <span className="lb-ai-mp-params">{active.params}</span>
        <svg className="lb-ai-mp-chev" viewBox="0 0 24 24" aria-hidden={true}>
          <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="lb-ai-mp-pop" role="dialog" aria-label="Select a model">
          {AI_MODELS.map((m) => (
            <button key={m.id} type="button" className="lb-ai-mp-opt" onClick={() => setOpen(false)}>
              <span className="lb-ai-mark" aria-hidden={true} dangerouslySetInnerHTML={{ __html: MISTRAL_MARK }} />
              <span className="lb-ai-model-item">
                <span className="lb-ai-model-name">{m.name} <span className="lb-ai-model-ver">{m.version}</span></span>
                <span className="lb-ai-model-params">{m.params}</span>
                <span className="lb-ai-model-note">{m.note}</span>
              </span>
              {m.id === active.id && (
                <span className="lb-ai-mp-check">
                  <m3e-icon name="check" aria-hidden={true} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
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

  const currentModel = AI_MODELS[0];

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
    setPhase("searching");

    /* Always-on search: Exa's MCP search is keyless, so every
       question searches first; a search failure never blocks the
       answer. */
    let sources: AiSource[] | undefined;
    try {
      sources = await aiSearch(text);
    } catch (e) {
      toast("Web search failed: " + msg(e) + " Answering without it.");
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

    setMessages((m) => [
      ...m,
      { role: "assistant", text: "", model: currentModel.id, sources },
    ]);
    setPhase(thinking ? "thinking" : "streaming");
    let acc = "";
    let thinkAcc = "";
    const flush = () =>
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: acc, thinking: thinkAcc || undefined };
        return copy;
      });
    let ok = false;
    try {
      for await (const ev of streamMistral({
        model: currentModel.id,
        messages: apiMessages,
        thinking,
      })) {
        if (ev.type === "quota") {
          setQuota(ev.remaining);
        } else if (ev.type === "thinking") {
          thinkAcc += ev.text;
        } else {
          acc += ev.text;
          setPhase("streaming");
        }
        flush();
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
              model: currentModel.id,
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
        <m3e-icon-button aria-label="Send" onClick={() => void send()}>
          <m3e-icon name="arrow_forward" aria-hidden={true} />
        </m3e-icon-button>
      </div>

      <div className="lb-ai-under">
        <ModelPicker />
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
