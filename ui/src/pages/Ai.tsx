import { useEffect, useRef, useState } from "react";
import {
  AI_MODELS,
  aiSearch,
  deleteChat,
  listChats,
  mergeUsage,
  needsThinking,
  runSubAgent,
  saveChat,
  SPAWN_AGENT_TOOL,
  streamChat,
  stripStreamTokens,
  splitHarmony,
  SUB_AGENT_MODELS,
  WEB_SEARCH_TOOL,
  RateLimitError,
  type AiChat,
  type AiModel,
  type AiMsg,
  type AiSub,
  type AiUsage,
  type ChatContent,
  type ChatMsg,
  type AiSource,
  type ToolCall,
} from "../ai/aiStore";
import { Markdown } from "../ai/Markdown";
import { formatElapsed } from "../ai/metrics";
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
   Provider marks (OpenAI, Meta) live on the model entries in
   aiStore.ts. */

const QUOTA_MAX = 50;

type Phase = "idle" | "searching" | "thinking" | "streaming" | "subagent";

/* The bottom sheet's imperative API (show/hide), kept local so the
   ref spread stays typed. */
type M3eBottomSheet = HTMLElement & { show: () => void; hide: () => void; open: boolean };

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

/* The conversation title the AI "gives" once it starts to work: the
   first meaningful line of its first answer (markdown decoration
   stripped), falling back to the user's message. Shown in the
   history sheet. */
function aiTitle(userText: string, answer: string): string {
  const line = answer
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("```"));
  const t = (line ?? userText).replace(/[*_`#>|]+/g, "").trim();
  return (t || userText).slice(0, 48);
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

/* Typewriter display (the 21st.dev ResponseStream pattern): rAF drains
   the rendered prefix toward the growing streamed answer. The
   per-frame chunk scales with the backlog so a long answer never lags
   behind the stream, and the settled turn jumps to the full text. */
function useTypewriter(target: string, active: boolean): string {
  const [shown, setShown] = useState(target);
  const posRef = useRef(0);
  const lastEmitRef = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (!active) {
      posRef.current = target.length;
      setShown(target);
      return;
    }
    let raf = 0;
    const step = () => {
      const t = targetRef.current;
      if (posRef.current < t.length) {
        const backlog = t.length - posRef.current;
        posRef.current += Math.max(1, Math.ceil(backlog / 8));
        /* Wave 91 (#244): the typewriter emits at most ~30 updates
           per second. A setShown every frame drove a full Markdown
           parse + sanitize per frame during streams; text at 30fps
           reads the same as 60fps and the backlog drain still keeps
           the rendered prefix from lagging the stream. */
        const now = performance.now();
        if (now - lastEmitRef.current >= 32) {
          lastEmitRef.current = now;
          setShown(t.slice(0, posRef.current));
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return active ? shown : target;
}

/* The answer bubble rendered through the typewriter layer while the
   turn streams; the settled turn renders the full text. */
function Answer({ text, typing }: { text: string; typing: boolean }) {
  const shown = useTypewriter(text, typing);
  return (
    <div className="lb-ai-bubble lb-ai-answer">
      <Markdown text={shown} />
    </div>
  );
}

export default function AiPage() {
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AiMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  /* Per-turn step durations (ms), shown beside settled tool rows. */
  const [dur, setDur] = useState<{ think?: number; search?: number }>({});
  /* The empty-state heading stays mounted while it fades out. */
  const [helloGone, setHelloGone] = useState(false);
  /* Remaining server quota; null until the first send answers. */
  const [quota, setQuota] = useState<number | null>(null);
  /* AgentChat (21st.dev) error part: a failed turn renders as an
     inline error card in the conversation with a Try again action,
     not a transient snackbar. */
  const [error, setError] = useState<{ title: string; message: string; retry?: () => void } | null>(null);
  /* Sub agent runs this turn: one shim row each, elapsed when done. */
  const [subs, setSubs] = useState<AiSub[]>([]);
  const [attached, setAttached] = useState<Attached[]>([]);
  /* Conversation history: encrypted chats in IndexedDB, listed into
     the bottom sheet; picking one loads it back into the page. */
  const [histChats, setHistChats] = useState<AiChat[]>([]);
  /* The attachment preview stays mounted while it fades out. */
  const [peekMounted, setPeekMounted] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sheetRef = useRef<M3eBottomSheet | null>(null);
  /* The saved conversation's title (kept across turns so updates do
     not retitle the chat). */
  const titleRef = useRef("");
  /* Abort chain for the in-flight turn (the Stop button). */
  const abortRef = useRef<AbortController | null>(null);

  /* The model picker is gone (user request 2026-11-06): GPT-OSS is
     the fixed main agent; Nemotron and Gemma stay reachable to it
     as sub agents (spawn_agent). A stored pick of a now-hidden
     model migrates back to the default on load (loadModelId). */
  const model: AiModel = AI_MODELS[0];

  /* Keep the newest message in view while it streams. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || phase !== "streaming") el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  /* Wave 79: the history sheet is non-modal (the M3E bottom sheet
     handles Escape only in modal mode and has no light dismiss), so
     the page wires the dismiss itself: a pointer press outside the
     sheet and the Escape key both close it. Capture-phase listeners
     fire before popover promotion; the row menus live inside the
     sheet's DOM, so their clicks and the sheet's own gestures never
     count as outside. */
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      const sheet = sheetRef.current;
      if (!sheet || !sheet.open) return;
      if (e.composedPath().includes(sheet)) return;
      sheet.hide();
    };
    const onKey = (e: KeyboardEvent) => {
      const sheet = sheetRef.current;
      if (e.key === "Escape" && sheet && sheet.open) sheet.hide();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  /* The attachment preview mounts with the first file and stays
     mounted for its fade-out after the last one clears. */
  useEffect(() => {
    if (attached.length > 0) setPeekMounted(true);
  }, [attached.length]);

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

  /* History: list the encrypted chats and raise the bottom sheet. */
  async function openHistory() {
    try {
      const all = await listChats();
      setHistChats(all.filter((c) => c.id != null));
    } catch {
      setHistChats([]);
    }
    sheetRef.current?.show();
  }

  function loadChat(c: AiChat) {
    if (busy) return;
    setMessages(c.messages);
    setCurrentId(c.id ?? null);
    titleRef.current = c.title;
    setHelloGone(true);
    sheetRef.current?.hide();
  }

  /* Delete with Undo: the record leaves IndexedDB immediately; Undo
     re-saves the kept chat object (same id restores the row). */
  function onDeleteChat(c: AiChat) {
    const id = c.id;
    if (id == null) return;
    Promise.resolve(deleteChat(id)).then(
      () => {
        setHistChats((l) => l.filter((x) => x.id !== id));
        if (typeof M3eSnackbar !== "undefined" && M3eSnackbar) {
          M3eSnackbar.open("Conversation deleted", "Undo", {
            actionCallback: () => {
              void saveChat(c).then(
                () => {
                  void openHistory();
                },
                () => toast("Conversation could not be restored.")
              );
            },
            duration: 8000,
          });
        }
      },
      () => toast("Conversation could not be deleted.")
    );
  }

  async function send(retry?: { text: string; files: Attached[] }) {
    const text = retry ? retry.text : draft.trim();
    const files = retry ? retry.files : attached;
    /* #235: an attachment alone is a valid turn - text files carry
       their own content and images re-route to the vision model;
       only a draft with no payload at all is a no-op. */
    if ((!text && files.length === 0) || busy) return;
    setError(null);
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
    const ac = new AbortController();
    abortRef.current = ac;
    setDur({});
    setSubs([]);
    let subRuns: AiSub[] = [];
    /* Turn metrics: total elapsed and token usage (main model plus
       every sub agent) for the counter line under the answer. */
    const t0 = Date.now();
    let usage: AiUsage | undefined;
    /* Step timers: a span opens when a step starts and closes when
       it settles; the accumulated ms render beside the settled
       label. */
    let thinkStart = 0;
    let thinkMs = 0;
    let searchStart = 0;
    let searchMs = 0;
    const endThink = () => {
      if (!thinkStart) return;
      thinkMs += Date.now() - thinkStart;
      thinkStart = 0;
      setDur((d) => ({ ...d, think: thinkMs }));
    };
    const endSearch = () => {
      if (!searchStart) return;
      searchMs += Date.now() - searchStart;
      searchStart = 0;
      setDur((d) => ({ ...d, search: searchMs }));
    };

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
      "You can call spawn_agent to delegate a self-contained subtask to a sub agent (Nemotron or Gemma) " +
      "that can search the web itself; its answer returns to you as the tool result. " +
      "Skip the tools when the answer needs no web lookup.";
    /* #235: image-only turns send parts with no text element; the
       server accepts part arrays without a text part. */
    const parts: ChatContent = withFiles
      ? [{ type: "text", text: withFiles }]
      : [];
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
    if (thinking) thinkStart = Date.now();
    let acc = "";
    let thinkAcc = "";
    let sources: AiSource[] | undefined;
    /* The answer renders only the harmony final channel; analysis
       text that leaked into content joins the thinking panel. */
    const flush = () =>
      setMessages((m) => {
        const copy = m.slice();
        const h = splitHarmony(acc);
        const thinkText = thinkAcc + (h.analysis ? (thinkAcc ? "\n" : "") + h.analysis : "");
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          text: h.final,
          thinking: thinkText || undefined,
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
          tools: [WEB_SEARCH_TOOL, SPAWN_AGENT_TOOL],
          signal: ac.signal,
        })) {
          if (ev.type === "quota") {
            setQuota(ev.remaining);
          } else if (ev.type === "thinking") {
            if (!thinkStart) thinkStart = Date.now();
            thinkAcc += ev.text;
            setPhase("thinking");
          } else if (ev.type === "text") {
            endThink();
            acc += ev.text;
            setPhase("streaming");
          } else if (ev.type === "tool_calls") {
            calls = ev.calls;
          } else if (ev.type === "finish") {
            finish = ev.reason;
            usage = mergeUsage(usage, ev.usage);
          }
          flush();
        }
        if (finish !== "tool_calls" || !calls.length) break;
        /* The model invoked a tool: replay its calls. web_search runs
        the keyless Exa search; spawn_agent runs a full sub agent turn
        whose text stays internal - the shim row inside the thinking
        panel is the only trace. */
        apiMessages.push({ role: "assistant", content: "", tool_calls: calls });
        for (const call of calls) {
          if (call.function.name === "spawn_agent") {
            let subModel = "";
            let task = text;
            try {
              const a = JSON.parse(call.function.arguments) as { model?: unknown; task?: unknown };
              subModel = String(a.model ?? "");
              task = String(a.task ?? text);
            } catch {
              /* malformed arguments: fall back to the turn text */
            }
            if (!(SUB_AGENT_MODELS as readonly string[]).includes(subModel)) subModel = SUB_AGENT_MODELS[0];
            setPhase("subagent");
            subRuns = [...subRuns, { task: task.slice(0, 100), ms: 0, status: "working" }];
            setSubs(subRuns);
            const subStart = Date.now();
            try {
              const r = await runSubAgent({ model: subModel, task, signal: ac.signal });
              apiMessages.push({
                role: "tool",
                tool_call_id: call.id,
                content: r.answer || "the sub agent returned an empty answer",
              });
              usage = mergeUsage(usage, r.usage);
              subRuns[subRuns.length - 1] = {
                ...subRuns[subRuns.length - 1],
                status: r.answer ? "done" : "failed",
              };
            } catch (e) {
              if (ac.signal.aborted) throw e;
              apiMessages.push({
                role: "tool",
                tool_call_id: call.id,
                content: "sub agent failed: " + msg(e),
              });
              subRuns[subRuns.length - 1] = {
                ...subRuns[subRuns.length - 1],
                status: "failed",
              };
            } finally {
              const ms = Date.now() - subStart;
              subRuns = subRuns.map((x, i) => (i === subRuns.length - 1 ? { ...x, ms } : x));
              setSubs(subRuns);
              setPhase("streaming");
            }
            continue;
          }
          let q = text;
          try {
            q = String(JSON.parse(call.function.arguments).query ?? text);
          } catch {
            /* malformed arguments: fall back to the turn text */
          }
          if (!searchStart) searchStart = Date.now();
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
          endSearch();
          flush();
        }
      }
      if (!acc && !thinkAcc) throw new Error("The model returned an empty response.");
      ok = true;
    } catch (e) {
      if (ac.signal.aborted) {
        /* Stop pressed: keep whatever already streamed and persist
           it as the turn's answer; nothing streamed drops the empty
           turn. No rollback, no toast, no summary. */
        if (acc || thinkAcc) ok = true;
        else setMessages((m) => m.slice(0, before));
      } else {
        /* Roll the failed turn back and show the failure as an inline
           error card (the AgentChat error part): it stays in context
           and its Try again replays the turn. Rate limits carry no
           retry button. */
        setMessages((m) => m.slice(0, before));
        const rl = e instanceof RateLimitError;
        setError({
          title: rl ? "Rate limit reached" : "The request failed",
          message: msg(e),
          retry: rl
            ? undefined
            : () => {
                void send({ text, files });
              },
        });
      }
    } finally {
      endThink();
      endSearch();
      abortRef.current = null;
      setBusy(false);
      setPhase("idle");
      /* The settled turn gets its counter line: total tokens (main
         model plus sub agents) and elapsed wall time. */
      const elapsed = Date.now() - t0;
      const finalUsage = usage;
      const finalSubs = subRuns.length ? subRuns : undefined;
      setMessages((m) => {
        const copy = m.slice();
        const lastM = copy[copy.length - 1];
        if (lastM && lastM.role === "assistant") {
          copy[copy.length - 1] = { ...lastM, ms: elapsed, usage: finalUsage, subs: finalSubs };
        }
        return copy;
      });
      /* Persist the turn; a storage failure never loses it from view. */
      if (ok) {
        const h = splitHarmony(acc);
        const thinkText = thinkAcc + (h.analysis ? (thinkAcc ? "\n" : "") + h.analysis : "");
        const title =
          before === 0 ? aiTitle(text, h.final) : titleRef.current || text.slice(0, 48);
        titleRef.current = title;
        try {
          const all = [
            ...messages,
            userMsg,
            {
              role: "assistant" as const,
              text: h.final,
              thinking: thinkText ? stripStreamTokens(thinkText) : undefined,
              model: turnModel.id,
              sources,
              ms: elapsed,
              usage: finalUsage,
              subs: finalSubs,
            },
          ];
          const id = await saveChat({
            id: currentId ?? undefined,
            title,
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
      <button
        type="button"
        className="lb-ai-hist-btn"
        aria-label="Conversation history"
        onClick={() => void openHistory()}
      >
        <m3e-icon name="history" aria-hidden={true} />
      </button>
      <div className="lb-ai-msgs" ref={scrollRef}>
        {!helloGone && (
          <div
            className={"lb-ai-hello" + (messages.length > 0 || busy ? " lb-out" : "")}
            onAnimationEnd={(e) => {
              if (e.animationName === "lb-ai-hello-out") setHelloGone(true);
            }}
          >
            How can I help you today?
          </div>
        )}
        {messages.map((m, i) => {
          const last = i === messages.length - 1;
          /* Sub agent shim rows: the live state while the turn runs,
             the recorded ones once the turn settles. They render
             inside the thinking panel, never in the output. */
          const subList = m.subs ? m.subs : last && busy ? subs : undefined;
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
              {m.role === "assistant" &&
                (m.thinking ||
                  (m.sources && m.sources.length > 0) ||
                  subList ||
                  (last && busy && (phase === "thinking" || phase === "searching" || phase === "subagent"))) && (
                  <ToolRow
                    label={
                      phase === "searching"
                        ? "Searching"
                        : phase === "subagent"
                          ? "Running sub agents"
                          : "Thinking"
                    }
                    doneLabel={m.thinking ? "Thought" : "Worked"}
                    active={last && busy && phase !== "streaming" && phase !== "idle"}
                    duration={last && m.thinking ? dur.think : undefined}
                  >
                    {m.thinking && (
                      <pre className="lb-ai-think-pre">{stripStreamTokens(m.thinking)}</pre>
                    )}
                    {m.sources && m.sources.length > 0 && (
                      <ToolRow
                        label="Searching the web"
                        doneLabel="Searched the web"
                        active={last && busy && phase === "searching"}
                        duration={last ? dur.search : undefined}
                      >
                        <div className="lb-ai-sources">
                          {m.sources.map((s, j) => (
                            <a key={j} className="lb-ai-src" href={s.url} target="_blank" rel="noreferrer">
                              {s.title}
                            </a>
                          ))}
                        </div>
                      </ToolRow>
                    )}
                    {subList && subList.length > 0 && (
                      <div className="lb-ai-subs">
                        {subList.map((s, j) => {
                          const st = s.status ?? (s.ms ? "done" : "working");
                          return (
                            <div key={j} className="lb-ai-sub">
                              <span
                                className={"lb-ai-tool-label" + (st === "working" ? " lb-ai-shimmer" : "")}
                                role="status"
                              >
                                {st === "failed" ? "Sub agent failed" : st === "working" ? "Sub agent working" : "Sub agent done"}
                              </span>
                              <span className="lb-ai-sub-task">{s.task}</span>
                              {s.ms > 0 && <span className="lb-ai-sub-ms">{formatElapsed(s.ms)}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ToolRow>
                )}
              {m.role === "user" && m.text && <div className="lb-ai-bubble">{m.text}</div>}
              {m.role === "assistant" && m.text && (
                <Answer text={m.text} typing={last && busy && phase === "streaming"} />
              )}
              {m.role === "assistant" && last && busy && phase === "streaming" && !m.text && !m.thinking && (
                <div className="lb-ai-tool">
                  <span className="lb-ai-tool-label lb-ai-shimmer" role="status">
                    Working
                  </span>
                </div>
              )}
              {m.role === "assistant" && !busy && (m.usage || m.ms != null) && (
                <div className="lb-ai-meta">
                  {m.usage && (
                    <span>
                      {m.usage.totalTokens} tokens ({m.usage.promptTokens} in / {m.usage.completionTokens} out)
                    </span>
                  )}
                  {m.ms != null && <span>{formatElapsed(m.ms)}</span>}
                </div>
              )}
            </div>
          );
        })}
        {error && (
          <div className="lb-ai-error" role="alert">
            <div className="lb-ai-error-title">{error.title}</div>
            <div className="lb-ai-error-msg">{error.message}</div>
            {error.retry && (
              <button
                type="button"
                className="lb-ai-error-retry"
                onClick={() => {
                  const retry = error.retry;
                  setError(null);
                  retry?.();
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>

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
        <div className="lb-ai-bar-main">
          <m3e-search-bar>
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
          {peekMounted && (
            <div
              className={"lb-ai-att-peek" + (attached.length === 0 ? " lb-out" : "")}
              onAnimationEnd={(e) => {
                if (e.animationName === "lb-ai-peek-out") setPeekMounted(false);
              }}
            >
              {attached.map((f, i) => (
                <span key={i} className={f.kind === "image" ? "lb-ai-att-thumb" : "lb-ai-file-chip"}>
                  {f.kind === "image" && f.dataUrl ? (
                    <img src={f.dataUrl} alt={f.name} />
                  ) : (
                    f.name
                  )}
                  <button
                    className="lb-ai-att-x"
                    aria-label={"Remove " + f.name}
                    onClick={() => setAttached((a) => a.filter((_, j) => j !== i))}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <m3e-button
          variant="tonal"
          {...{ class: "lb-ai-send" }}
          {...(busy || draft.trim() || attached.length ? {} : { disabled: true })}
          aria-label={busy ? "Stop" : "Send"}
          onClick={() => (busy ? abortRef.current?.abort() : void send())}
        >
          <m3e-icon slot="icon" name={busy ? "stop" : "send"} aria-hidden={true} />
          {busy ? "Stop" : "Send"}
        </m3e-button>
      </div>

      <div className="lb-ai-under">
        <span
          className={"lb-ai-quota" + (quota !== null && quota <= 0 ? " lb-ai-quota-out" : "")}
          title={quota !== null ? quota + " of " + QUOTA_MAX + " messages left in the current 6 hour window" : undefined}
        >
          {quotaUsed}/{QUOTA_MAX}
        </span>
      </div>

      <m3e-bottom-sheet detents="fit" {...{ ref: sheetRef }}>
        <m3e-app-bar slot="header" size="small" {...{ class: "lb-sheet-bar" }}>
          <m3e-icon-button slot="leading" aria-label="Back" onClick={() => sheetRef.current?.hide()}>
            <m3e-icon name="arrow_back" aria-hidden={true} />
          </m3e-icon-button>
          <span slot="title">Conversations</span>
        </m3e-app-bar>
        <div className="lb-ai-hist">
          {histChats.length === 0 && (
            <div className="lb-ai-hist-empty">
              No saved conversations yet. Chats are saved encrypted on this device.
            </div>
          )}
          {histChats.map((c) => (
            <div key={c.id} className="lb-ai-hist-row">
              <div
                className="lb-ai-hist-main"
                role="button"
                tabIndex={0}
                onClick={() => loadChat(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    loadChat(c);
                  }
                }}
              >
                <span className="lb-ai-hist-title">{c.title || "Untitled"}</span>
                <span className="lb-ai-hist-date">{new Date(c.updated).toLocaleString()}</span>
              </div>
              <m3e-menu-trigger for={"lb-ai-hist-menu-" + c.id}>
                <m3e-icon-button aria-label={"Options for " + (c.title || "a conversation")}>
                  <m3e-icon name="more_vert" aria-hidden={true} />
                </m3e-icon-button>
              </m3e-menu-trigger>
              <m3e-menu id={"lb-ai-hist-menu-" + c.id}>
                <m3e-menu-item onClick={() => onDeleteChat(c)}>Delete</m3e-menu-item>
              </m3e-menu>
            </div>
          ))}
        </div>
      </m3e-bottom-sheet>
    </div>
  );
}
