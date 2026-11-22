/**
 * `linkCard`: a block that shows a saved link preview. Everything it shows is
 * stored in its attributes (inside the encrypted note), so it renders offline
 * and makes no network request. Video embeds load only when Play is clicked.
 */
import { Node, type Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { embedUrl, fetchPreview, isHttpUrl, type CardData } from "../previews";

const FIELDS = ["url", "title", "description", "siteName", "image"] as const;

/** Links whose preview is being fetched on this device (loading state is never written to the doc). */
const pending = new Set<string>();
/**
 * Finished fetches (null = no preview), kept for this session so a card whose
 * note was closed mid-fetch is filled in when it's shown again.
 */
const results = new Map<string, CardData | null>();
/** Open editors, so a result reaches whichever one shows the card now. */
const live = new Set<Editor>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A paragraph holding just the link. */
function plainLink(schema: Schema, url: string): PMNode {
  return schema.nodes.paragraph!.create(null, schema.text(url, [schema.marks.link!.create({ href: url })]));
}

/** Fills every still-empty card for `url`, or turns it back into a plain link when there's no preview. */
function fill(editor: Editor, url: string, data: CardData | null): void {
  if (editor.isDestroyed) return;
  const { tr } = editor.state;
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name !== "linkCard" || n.attrs.url !== url || n.attrs.title) return;
    const at = tr.mapping.map(pos);
    if (data) tr.setNodeMarkup(at, undefined, data);
    else tr.replaceWith(at, at + n.nodeSize, plainLink(editor.schema, url));
  });
  // Part of the same user action as inserting the card: one undo removes both.
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
}

export const LinkCard = Node.create({
  name: "linkCard",
  group: "block",
  atom: true,
  draggable: true,

  onCreate() {
    live.add(this.editor);
  },
  onDestroy() {
    live.delete(this.editor);
  },

  addAttributes() {
    return Object.fromEntries(
      FIELDS.map((f) => [
        f,
        {
          default: null,
          parseHTML: (e: HTMLElement) => e.getAttribute(`data-${f}`),
          renderHTML: (a: Record<string, unknown>) => (a[f] ? { [`data-${f}`]: a[f] } : {}),
        },
      ]),
    );
  },

  parseHTML() {
    // Pasted HTML is untrusted: only http(s) links make a card, and only data:image thumbnails.
    return [
      {
        tag: "div[data-link-card]",
        getAttrs: (e) => {
          const img = e.getAttribute("data-image");
          return isHttpUrl(e.getAttribute("data-url") ?? "") && (!img || img.startsWith("data:image/")) ? null : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const url = String(node.attrs.url);
    // Synced attrs skip parseHTML's checks, so the scheme is checked again wherever url becomes an href.
    return ["div", { ...HTMLAttributes, "data-link-card": "" }, ["a", isHttpUrl(url) ? { href: url } : {}, String(node.attrs.title ?? url)]];
  },

  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      let node = initial;
      let playing = false;
      const dom = el("div", "link-card");
      dom.contentEditable = "false";

      const render = () => {
        const a = node.attrs as Partial<CardData> & { url: string };
        const state = a.title ? "loaded" : pending.has(a.url) ? "loading" : "none";
        dom.dataset.state = state;
        dom.replaceChildren();
        const body = el("div", "card-row");
        const textCol = el("div", "card-text");
        if (state === "loading") {
          textCol.append(...[1, 2, 3, 4].map(() => el("span", "skeleton")));
          body.append(textCol, el("div", "card-thumb skeleton"));
          dom.setAttribute("aria-busy", "true");
          dom.append(body);
          return;
        }
        dom.removeAttribute("aria-busy");
        const link = el("a", "card-title", a.title ?? a.url);
        if (isHttpUrl(a.url)) link.href = a.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        textCol.append(link);
        if (state === "none") textCol.append(el("p", "card-desc", "No preview available for this link"));
        else {
          if (a.description) textCol.append(el("p", "card-desc", a.description));
          textCol.append(el("span", "card-site", `🌐 ${a.siteName || host(a.url)}`));
        }
        body.append(textCol);
        const embed = embedUrl(a.url);
        if (state === "loaded" && (a.image || embed)) {
          const thumb = el("div", "card-thumb");
          if (a.image?.startsWith("data:image/")) {
            const img = el("img", "");
            img.src = a.image;
            img.alt = "";
            thumb.append(img);
          }
          if (embed) {
            const play = el("button", "card-play", "▶");
            play.type = "button";
            play.setAttribute("aria-label", "Play video");
            play.onclick = () => {
              playing = true;
              render();
            };
            thumb.append(play);
          }
          body.append(thumb);
        }
        const actions = el("div", "card-actions");
        const plain = el("button", "", "Show as link");
        const remove = el("button", "danger", "Remove");
        plain.type = remove.type = "button";
        plain.onclick = () => {
          const pos = getPos();
          if (typeof pos === "number") editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, plainLink(editor.schema, String(node.attrs.url))));
        };
        remove.onclick = () => {
          const pos = getPos();
          if (typeof pos === "number") editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
        };
        actions.append(plain, remove);
        dom.append(body, actions);
        if (playing && embed) {
          const frame = el("iframe", "card-embed");
          frame.src = embed;
          frame.title = a.title ?? "Video";
          frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
          frame.allowFullscreen = true;
          frame.referrerPolicy = "strict-origin-when-cross-origin"; // YouTube refuses to play without a referrer
          dom.append(frame);
        }
      };

      render();
      // An empty card whose fetch already finished (its note was closed meanwhile): fill it now.
      const done = node.attrs.title ? undefined : results.get(String(node.attrs.url));
      if (done !== undefined) queueMicrotask(() => fill(editor, String(node.attrs.url), done));
      return {
        dom,
        update: (next) => {
          if (next.type !== node.type) return false;
          if (next.attrs.url !== node.attrs.url) playing = false;
          node = next;
          render();
          return true;
        },
        // Links, buttons and the player handle their own clicks; ProseMirror shouldn't select the card for them.
        stopEvent: (e) => !!(e.target as HTMLElement).closest?.("a, button, iframe"),
        ignoreMutation: () => true,
      };
    };
  },
});

/** The top-level paragraph under the caret, if it holds nothing but one link (no hard breaks or other inline nodes). */
export function linkLine(editor: Editor): { from: number; to: number; url: string } | null {
  const { $from, empty } = editor.state.selection;
  const p = $from.parent;
  if (!empty || $from.depth !== 1 || p.type.name !== "paragraph" || p.childCount !== 1 || !p.firstChild!.isText) return null;
  const url = p.textContent.trim();
  return isHttpUrl(url) ? { from: $from.before(), to: $from.after(), url } : null;
}

/**
 * Replaces the link line under the caret with a loading card, then fills it in
 * or turns it back into a plain link. The line is read at click time, so edits
 * from other devices since the last render can't shift it.
 */
export function showAsPreview(editor: Editor): void {
  const line = linkLine(editor);
  if (!line) return;
  const { url } = line;
  pending.add(url);
  const last = line.to === editor.state.doc.content.size;
  // A paragraph after a trailing card keeps somewhere to type.
  editor.chain().focus().insertContentAt({ from: line.from, to: line.to }, last ? [{ type: "linkCard", attrs: { url } }, { type: "paragraph" }] : { type: "linkCard", attrs: { url } }).run();
  void fetchPreview(url).then((data) => {
    pending.delete(url);
    results.set(url, data);
    for (const ed of live) fill(ed, url, data);
  });
}
