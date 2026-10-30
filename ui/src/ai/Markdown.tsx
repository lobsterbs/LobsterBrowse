/* Streaming markdown renderer: the agent-elements markdown idea
   (render assistant text as real markdown, not a flat block)
   hand-ported with no streamdown dependency. marked parses GFM
   (headings, lists, tables, blockquotes, fenced code, links) and
   DOMPurify sanitizes the HTML before it enters the page. Styles
   live in theme.css under .lb-md, all M3E tokens. */
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text }: { text: string }): JSX.Element {
  const raw = marked.parse(text, { async: false });
  const html = DOMPurify.sanitize(raw as string);
  return <div className="lb-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
