/**
 * Everything that pulls in Tiptap/ProseMirror lives here, so NoteEditor can
 * load it with import() and the app shell stays small (DESIGN.md D13).
 */
import { Editor, Extension } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
// Subpath imports: the package root pulls in every list extension and keymap.
import { BulletList } from "@tiptap/extension-list/bullet-list";
import { ListItem } from "@tiptap/extension-list/item";
import { OrderedList } from "@tiptap/extension-list/ordered-list";
import { TaskItem } from "@tiptap/extension-list/task-item";
import { TaskList } from "@tiptap/extension-list/task-list";
import Paragraph from "@tiptap/extension-paragraph";
import Strike from "@tiptap/extension-strike";
import Text from "@tiptap/extension-text";
import type * as Y from "yjs";

/** Mod-K: remove the link under the caret, or ask for a URL and link the selection (or insert it as text). */
const LinkShortcut = Extension.create({
  name: "linkShortcut",
  addKeyboardShortcuts() {
    return {
      "Mod-k": ({ editor }) => {
        if (editor.isActive("link")) return editor.chain().focus().extendMarkRange("link").unsetLink().run();
        const href = prompt("Link URL")?.trim();
        // can() runs Link's URL validation (rejects javascript: and friends) without applying anything.
        if (!href || !editor.can().setLink({ href })) return true;
        const c = editor.chain().focus();
        return editor.state.selection.empty
          ? c.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run()
          : c.setLink({ href }).run();
      },
    };
  },
});

export function createEditor(
  element: HTMLElement,
  fragment: Y.XmlFragment,
  onLocalChange: (firstBlock: string) => void,
  onTransaction: () => void,
): Editor {
  return new Editor({
    element,
    // Picked one by one instead of StarterKit to keep unused extensions out of the bundle.
    extensions: [
      Document, Paragraph, Text, HardBreak,
      Heading.configure({ levels: [1, 2, 3] }),
      Bold, Italic, Strike, Code, CodeBlock, Blockquote, HorizontalRule,
      BulletList, OrderedList, ListItem, TaskList, TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false }),
      LinkShortcut,
      Collaboration.configure({ fragment }), // brings its own Yjs-aware undo/redo
    ],
    autofocus: true,
    onUpdate: ({ editor, transaction }) => {
      // Remote changes already carry their author's title update in the index doc.
      if (!isChangeOrigin(transaction)) onLocalChange(editor.state.doc.firstChild?.textContent ?? "");
    },
    onTransaction,
  });
}
