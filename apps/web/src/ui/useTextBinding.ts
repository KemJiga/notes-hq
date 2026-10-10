import { useEffect, useRef } from "preact/hooks";
import type * as Y from "yjs";

const LOCAL = Symbol("textarea");

/**
 * Two-way binding between a <textarea> and a Y.Text, using a prefix/suffix
 * diff. Placeholder until the real editor (CodeMirror 6 or Tiptap) is chosen.
 */
export function useTextBinding(text: Y.Text | null, onLocalChange?: (value: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cb = useRef(onLocalChange);
  cb.current = onLocalChange;

  useEffect(() => {
    const el = ref.current;
    if (!el || !text) return;
    el.value = text.toString();

    const onInput = () => {
      const prev = text.toString();
      const next = el.value;
      let start = 0;
      while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
      let endPrev = prev.length;
      let endNext = next.length;
      while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
        endPrev--;
        endNext--;
      }
      text.doc!.transact(() => {
        if (endPrev > start) text.delete(start, endPrev - start);
        if (endNext > start) text.insert(start, next.slice(start, endNext));
      }, LOCAL);
      cb.current?.(next);
    };

    const observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin === LOCAL) return;
      // Shift the caret by the length of remote inserts/deletes before it.
      let { selectionStart: s, selectionEnd: e } = el;
      let pos = 0;
      for (const op of event.delta) {
        if (op.retain) pos += op.retain;
        else if (typeof op.insert === "string") {
          const n = op.insert.length;
          if (pos <= s) s += n;
          if (pos <= e) e += n;
          pos += n;
        } else if (op.delete) {
          if (pos < s) s -= Math.min(op.delete, s - pos);
          if (pos < e) e -= Math.min(op.delete, e - pos);
        }
      }
      el.value = text.toString();
      if (document.activeElement === el) el.setSelectionRange(s, e);
    };

    el.addEventListener("input", onInput);
    text.observe(observer);
    return () => {
      el.removeEventListener("input", onInput);
      text.unobserve(observer);
    };
  }, [text]);

  return ref;
}
