/**
 * The page reader behind the enrich stage, ported from PageText in
 * bridges/nutribiotic/places_search_ingest.py (a stdlib html.parser subclass).
 * Visible text with paragraph breaks, the meta description, the title, and
 * every link with its anchor text. Same tag sets, same callbacks, same order.
 */
import { decodeHTML } from "entities";

const BLOCK_TAGS = new Set(["p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br", "td", "tr", "blockquote", "figcaption"]);
const DROP_TAGS = new Set(["script", "style", "noscript", "svg", "template", "iframe"]);
// html.parser reads these two as raw text: no tag inside them is parsed.
const RAW_TEXT = new Set(["script", "style"]);

const START_TAG = /<([a-zA-Z][^\t\n\f\r />]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const END_TAG = /<\/([a-zA-Z][^\t\n\f\r />]*)[^>]*>/y;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/y;
const DECL = /<[!?][^>]*>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export class PageText {
  chunks: string[] = [];
  links: [string, string][] = [];
  title = "";
  metaDesc = "";
  private skip = 0;
  private inTitle = false;
  private href: string | null = null;
  private anchor: string[] = [];

  constructor(html: string) {
    this.feed(html);
  }

  private startTag(tag: string, attrs: Map<string, string | null>) {
    if (DROP_TAGS.has(tag)) {
      this.skip += 1;
    } else if (tag === "title") {
      this.inTitle = true;
    } else if (tag === "meta") {
      const key = (attrs.get("name") || attrs.get("property") || "").trim().toLowerCase();
      const content = (attrs.get("content") || "").trim();
      if (content && (key === "description" || key === "og:description") && !this.metaDesc) {
        this.metaDesc = content;
      }
    } else if (tag === "a") {
      this.href = attrs.has("href") ? attrs.get("href") ?? null : null;
      this.anchor = [];
    }
    if (BLOCK_TAGS.has(tag)) this.chunks.push("\n");
  }

  private endTag(tag: string) {
    if (DROP_TAGS.has(tag) && this.skip) {
      this.skip -= 1;
    } else if (tag === "title") {
      this.inTitle = false;
    } else if (tag === "a") {
      if (this.href) this.links.push([this.href, this.anchor.join("").split(/\s+/).filter(Boolean).join(" ")]);
      this.href = null;
      this.anchor = [];
    }
    if (BLOCK_TAGS.has(tag)) this.chunks.push("\n");
  }

  private data(raw: string) {
    if (!raw) return;
    const data = decodeHTML(raw);
    if (this.skip) return;
    if (this.inTitle) {
      this.title += data;
      return;
    }
    if (this.href !== null) this.anchor.push(data);
    this.chunks.push(data);
  }

  private feed(html: string) {
    let i = 0;
    let textStart = 0;
    const n = html.length;
    let lower: string | null = null;
    const flush = (end: number) => {
      if (end > textStart) this.data(html.slice(textStart, end));
    };
    while (i < n) {
      const lt = html.indexOf("<", i);
      if (lt === -1) break;
      i = lt;
      let m: RegExpExecArray | null;

      COMMENT.lastIndex = i;
      if ((m = COMMENT.exec(html))) {
        flush(i);
        i = COMMENT.lastIndex;
        textStart = i;
        continue;
      }
      END_TAG.lastIndex = i;
      if ((m = END_TAG.exec(html))) {
        flush(i);
        this.endTag(m[1].toLowerCase());
        i = END_TAG.lastIndex;
        textStart = i;
        continue;
      }
      START_TAG.lastIndex = i;
      if ((m = START_TAG.exec(html))) {
        flush(i);
        const tag = m[1].toLowerCase();
        const attrSrc = m[2];
        const selfClosing = /\/\s*$/.test(attrSrc);
        const attrs = new Map<string, string | null>();
        for (const a of attrSrc.matchAll(ATTR)) {
          const val = a[2] ?? a[3] ?? a[4];
          attrs.set(a[1].toLowerCase(), val === undefined ? null : decodeHTML(val));
        }
        this.startTag(tag, attrs);
        i = START_TAG.lastIndex;
        if (selfClosing) {
          this.endTag(tag);
        } else if (RAW_TEXT.has(tag)) {
          lower ??= html.replace(/[A-Z]/g, (c) => c.toLowerCase()); // length-preserving
          const close = lower.indexOf(`</${tag}`, i);
          const stop = close === -1 ? n : close;
          if (stop > i) this.data(html.slice(i, stop));
          i = stop;
        }
        textStart = i;
        continue;
      }
      DECL.lastIndex = i;
      if ((m = DECL.exec(html))) {
        flush(i);
        i = DECL.lastIndex;
        textStart = i;
        continue;
      }
      i += 1; // a bare "<" is text
    }
    flush(n);
  }

  text(): string {
    const raw = this.chunks.join("").replace(/[ \t\r\f\v]+/g, " ");
    return raw
      .split("\n")
      .map((ln) => ln.trim())
      .filter(Boolean)
      .join("\n");
  }
}
