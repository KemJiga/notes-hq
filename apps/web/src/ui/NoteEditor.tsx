import type { ChainedCommands, Editor } from "@tiptap/core";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type * as Y from "yjs";
import type { Tree } from "../folders";
import { openNoteContent, touchNote } from "../notes";
import { addTag, namesOf, removeTag, tagMap } from "../tags";
import { FolderChip } from "./move";

const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

type Tool = [label: string, title: string, active: [name: string, attrs?: Record<string, unknown>] | null, run: (c: ChainedCommands) => ChainedCommands];

// Titles show the keyboard shortcut; the markdown shortcut is noted where there is no key combo.
const TOOLS: Tool[] = [
  ["H1", `Heading 1 (${MOD}+Alt+1 or "# ")`, ["heading", { level: 1 }], (c) => c.toggleHeading({ level: 1 })],
  ["H2", `Heading 2 (${MOD}+Alt+2 or "## ")`, ["heading", { level: 2 }], (c) => c.toggleHeading({ level: 2 })],
  ["H3", `Heading 3 (${MOD}+Alt+3 or "### ")`, ["heading", { level: 3 }], (c) => c.toggleHeading({ level: 3 })],
  ["B", `Bold (${MOD}+B)`, ["bold"], (c) => c.toggleBold()],
  ["I", `Italic (${MOD}+I)`, ["italic"], (c) => c.toggleItalic()],
  ["S", `Strikethrough (${MOD}+Shift+S)`, ["strike"], (c) => c.toggleStrike()],
  ["</>", `Inline code (${MOD}+E)`, ["code"], (c) => c.toggleCode()],
  ["{ }", `Code block (${MOD}+Alt+C or "\`\`\`")`, ["codeBlock"], (c) => c.toggleCodeBlock()],
  ["•", `Bullet list (${MOD}+Shift+8 or "- ")`, ["bulletList"], (c) => c.toggleBulletList()],
  ["1.", `Numbered list (${MOD}+Shift+7 or "1. ")`, ["orderedList"], (c) => c.toggleOrderedList()],
  ["☐", `Checklist (${MOD}+Shift+9 or "[] ")`, ["taskList"], (c) => c.toggleTaskList()],
  ["❝", `Quote (${MOD}+Shift+B or "> ")`, ["blockquote"], (c) => c.toggleBlockquote()],
  ["―", `Divider ("---")`, null, (c) => c.setHorizontalRule()],
];

type Props = { id: string; index: Y.Map<Y.Map<unknown>>; tags: [string, number][]; tree: Tree; folderId: string | null; onDelete: () => void };

/** The note's tags as removable chips, and an input that autocompletes existing tags or creates one on Enter. */
function TagBar({ id, index, tags, tree, folderId }: Omit<Props, "onDelete">) {
  const [draft, setDraft] = useState("");
  const meta = index.get(id);
  const mine = meta ? namesOf(meta, tagMap(index)) : [];
  const add = (name: string) => addTag(index, id, name) && setDraft("");
  return (
    <div class="tagbar">
      <FolderChip index={index} tree={tree} noteId={id} folderId={folderId} />
      {mine.map((t) => (
        <span key={t} class="chip">
          {t}
          <button aria-label={`Remove tag ${t}`} onClick={() => removeTag(index, id, t)}>×</button>
        </span>
      ))}
      <input
        list="tag-suggestions"
        placeholder="+ Add tag"
        aria-label="Add tag"
        enterKeyHint="done"
        autocapitalize="none"
        value={draft}
        onInput={(e) => {
          const v = e.currentTarget.value;
          // Picking a suggestion replaces the text in one go: add it right away.
          if ((e as InputEvent).inputType === "insertReplacementText" || (!(e as InputEvent).inputType && tags.some(([t]) => t === v))) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          add(draft);
        }}
      />
      <datalist id="tag-suggestions">
        {tags.filter(([t]) => !mine.includes(t)).map(([t, n]) => (
          <option key={t} value={t} label={`${n} note${n === 1 ? "" : "s"}`} />
        ))}
      </datalist>
    </div>
  );
}

export function NoteEditor({ id, index, tags, tree, folderId, onDelete }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Re-render the toolbar on every transaction so active states follow the selection.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let ed: Editor | undefined;
    let cancelled = false;
    void Promise.all([openNoteContent(id), import("./tiptap")]).then(([fragment, { createEditor }]) => {
      if (cancelled) return;
      ed = createEditor(el.current!, fragment, (title) => touchNote(index, id, title), () => rerender(0));
      setEditor(ed);
    });
    return () => {
      cancelled = true;
      ed?.destroy();
    };
  }, [id, index]);

  return (
    <div class="editor">
      <div class="toolbar format" role="toolbar" aria-label="Formatting">
        {TOOLS.map(([label, title, active, run]) => {
          const on = !!editor && !!active && editor.isActive(...active);
          return (
            <button
              key={title}
              title={title}
              aria-label={title}
              aria-pressed={on}
              class={on ? "on" : ""}
              disabled={!editor}
              // Keep focus (and the mobile keyboard) in the editor.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor && run(editor.chain().focus()).run()}
            >
              {label}
            </button>
          );
        })}
        <button
          title={`Link (${MOD}+K)`}
          aria-label={`Link (${MOD}+K)`}
          aria-pressed={!!editor?.isActive("link")}
          class={editor?.isActive("link") ? "on" : ""}
          disabled={!editor}
          onMouseDown={(e) => e.preventDefault()}
          // Same code path as the shortcut (defined in tiptap.ts).
          onClick={() => editor?.commands.keyboardShortcut("Mod-k")}
        >
          🔗
        </button>
        <button class="danger" onClick={onDelete}>Delete</button>
      </div>
      <TagBar id={id} index={index} tags={tags} tree={tree} folderId={folderId} />
      <div ref={el} class="content" />
    </div>
  );
}
