/**
 * HTML → markdown converter, zero dependencies (Claude Code bundles turndown;
 * this extension is loaded from ~/.pi/agent/extensions and stays dep-free).
 * Quality target: readable text with headings, links, lists, and code blocks
 * for an LLM — not perfect fidelity. Hard pages get the Jina fallback.
 *
 * Implemented as linear scans instead of regex passes: a hostile page of
 * unclosed tags must not trigger quadratic backtracking (a 5MB page of
 * `<script>` opens froze the regex version for minutes).
 */

const REMOVED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "template",
  "head",
]);

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "details",
  "summary",
  "blockquote",
  "ul",
  "ol",
  "table",
]);

const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&laquo;": "«",
  "&raquo;": "»",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&bull;": "•",
  "&middot;": "·",
};

function safeFromCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function decodeEntities(text: string): string {
  // Numeric first, then named (&amp; is in NAMED_ENTITIES, so it decodes last).
  text = text.replace(/&#x([0-9a-f]+);/gi, (_m, hex) =>
    safeFromCodePoint(parseInt(hex, 16)),
  );
  text = text.replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(Number(dec)));
  return text.replace(/&[a-z0-9#]+;/gi, (entity) => {
    const key = entity.toLowerCase();
    return NAMED_ENTITIES[key] ?? entity;
  });
}

// --- linear helpers ---------------------------------------------------------

interface ParsedTag {
  name: string;
  isClosing: boolean;
  attrs: string;
  end: number; // index just past the closing ">"
}

/** All ">" positions, so tag lookups are O(log n) and the scan stays linear. */
function gtPositions(input: string): number[] {
  const positions: number[] = [];
  let i = input.indexOf(">");
  while (i !== -1) {
    positions.push(i);
    i = input.indexOf(">", i + 1);
  }
  return positions;
}

function nextGtIndex(positions: number[], from: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < positions.length ? positions[lo] : -1;
}

/** Parse a tag at a "<"; null when the "<" is literal text, not markup. */
function parseTag(input: string, lt: number, gts: number[]): ParsedTag | null {
  let nameStart = lt + 1;
  let isClosing = false;
  const first = input[nameStart];
  if (first === "!" || first === "?") {
    // comments/doctype/PIs: skip silently to the closing ">"
    const gt = nextGtIndex(gts, lt);
    return gt === -1
      ? null
      : { name: "", isClosing: false, attrs: "", end: gt + 1 };
  }
  if (first === "/") {
    isClosing = true;
    nameStart++;
  }
  const nameFirst = input[nameStart];
  if (!nameFirst || !/[a-zA-Z]/.test(nameFirst)) return null; // "< b" prose
  const gt = nextGtIndex(gts, lt);
  if (gt === -1) return null;
  const raw = input.slice(nameStart, gt);
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1].toLowerCase(),
    isClosing,
    attrs: raw.slice(nameMatch[1].length),
    end: gt + 1,
  };
}

/** Remove whole elements by name; unclosed elements drop to end of input. */
function removeElementRanges(input: string, names: Set<string>): string {
  const gts = gtPositions(input);
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    const tag = parseTag(input, lt, gts);
    if (tag && !tag.isClosing && names.has(tag.name)) {
      out += input.slice(i, lt);
      const close = input.toLowerCase().indexOf(`</${tag.name}`, lt);
      if (close === -1) break; // unclosed: the rest of the page is element content
      const gt = nextGtIndex(gts, close);
      i = gt === -1 ? input.length : gt + 1;
      continue;
    }
    out += input.slice(i, lt + 1);
    i = lt + 1;
  }
  return out;
}

function attrValue(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(
    attrs,
  );
  return match?.[1];
}

const PLACEHOLDER_MARK = "\u0000\u0002"; // improbable in real pages

export function htmlToMarkdown(html: string): string {
  // 1. Comments.
  const comments = html.match(/<!--[\s\S]*?-->/g);
  if (comments) {
    for (const comment of comments) html = html.replace(comment, "");
  }

  // 2. Pull <pre> blocks out first so code survives untouched.
  const preBlocks: string[] = [];
  {
    const preOpen = /<pre\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    let built = "";
    let i = 0;
    while ((match = preOpen.exec(html)) !== null) {
      built += html.slice(i, match.index);
      const close = html
        .toLowerCase()
        .indexOf("</pre", match.index + match[0].length);
      const gt = html.indexOf(">", close === -1 ? 0 : close);
      const end = gt === -1 ? html.length : gt + 1;
      const content =
        close === -1
          ? html.slice(match.index + match[0].length)
          : html.slice(match.index + match[0].length, close);
      const index = preBlocks.length;
      // A real page wraps pre content in <code>…</code>; drop the wrapper.
      preBlocks.push(
        content.replace(/<\/?code\b[^>]*>/gi, "").replace(/^\n+|\n+$/g, ""),
      );
      built += `\n${PLACEHOLDER_MARK}${index}\n`;
      i = end;
      preOpen.lastIndex = i;
      if (close === -1) break; // unclosed pre: the rest is code
    }
    built += html.slice(i);
    html = built;
  }

  // 3. Whole elements that never carry content.
  html = removeElementRanges(html, REMOVED_ELEMENTS);

  // 4. Main pass: structural and inline conversion, anchor wrapping.
  const gts = gtPositions(html);
  let out = "";
  let i = 0;
  let anchor: { start: number; href: string | null } | null = null;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const tag = parseTag(html, lt, gts);
    if (!tag) {
      out += "<";
      i = lt + 1;
      continue;
    }
    i = tag.end;

    if (tag.name === "a") {
      if (!tag.isClosing) {
        anchor = {
          start: out.length,
          href: attrValue(tag.attrs, "href") ?? null,
        };
      } else if (anchor) {
        const inner = out
          .slice(anchor.start)
          .replace(/<[^>]+>/g, "")
          .trim();
        out =
          out.slice(0, anchor.start) +
          (anchor.href && inner ? `[${inner}](${anchor.href})` : inner);
        anchor = null;
      }
      continue;
    }

    if (tag.isClosing) {
      if (tag.name === "strong" || tag.name === "b") out += "**";
      else if (tag.name === "em" || tag.name === "i") out += "*";
      else if (tag.name === "code") out += "`";
      else if (BLOCK_TAGS.has(tag.name)) out += "\n";
      else if (tag.name === "tr" || tag.name === "table") out += "\n";
      continue;
    }

    if (/^h[1-6]$/.test(tag.name)) {
      out += `\n${"#".repeat(Number(tag.name[1]))} `;
    } else if (tag.name === "li") {
      out += "\n- ";
    } else if (tag.name === "td" || tag.name === "th") {
      out += " | ";
    } else if (tag.name === "tr" || tag.name === "table") {
      out += "\n";
    } else if (tag.name === "br") {
      out += "\n";
    } else if (tag.name === "hr") {
      out += "\n---\n";
    } else if (tag.name === "strong" || tag.name === "b") {
      out += "**";
    } else if (tag.name === "em" || tag.name === "i") {
      out += "*";
    } else if (tag.name === "code") {
      out += "`";
    } else if (tag.name === "img") {
      const src = attrValue(tag.attrs, "src");
      if (src) {
        const alt = attrValue(tag.attrs, "alt")?.trim() || "image";
        out += `![${alt}](${src})`;
      }
    } else if (BLOCK_TAGS.has(tag.name)) {
      out += "\n";
    }
    // anything else: markup stripped, text kept
  }

  // 5. Restore code blocks.
  out = out.replace(
    new RegExp(`${PLACEHOLDER_MARK}(\\d+)`, "g"),
    (_m, index) => `\n\`\`\`\n${preBlocks[Number(index)] ?? ""}\n\`\`\`\n`,
  );

  // 6. Entities and whitespace.
  return collapseWhitespace(decodeEntities(out));
}

function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough visible-text length, used to detect pages that extracted as shells. */
export function visibleCharCount(markdown: string): number {
  return markdown
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[#*`>|\[\]()!_\s-]/g, "").length;
}
