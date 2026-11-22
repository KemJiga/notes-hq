import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

/** A fresh, isolated "device" joined to the given sync session. */
async function device(browser: Browser, secret: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  // Lets a test cut this device off from the relay: while blocked, sockets go to a dead port.
  await page.addInitScript(() => {
    const w = window as unknown as { __ws: WebSocket[]; __block: boolean };
    const WS = window.WebSocket;
    w.__ws = [];
    w.__block = false;
    window.WebSocket = class extends WS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(w.__block ? "ws://127.0.0.1:9" : url, protocols);
        w.__ws.push(this);
      }
    };
  });
  const relay = test.info().project.use.baseURL!.replace(/^http/, "ws");
  await page.goto(`/#join?${new URLSearchParams({ r: relay, k: secret })}`);
  await expect(page.getByRole("button", { name: "New note" })).toBeEnabled();
  return page;
}

const newSecret = () => randomBytes(32).toString("base64url");
const editor = (p: Page) => p.locator(".ProseMirror");
// innerHTML minus attributes that only reflect local DOM state.
const content = (p: Page) => editor(p).evaluate((e) => e.innerHTML.replaceAll(' class=""', ""));
const sidebarTitle = (p: Page) => p.locator("aside li button").first().evaluate((e) => e.firstChild!.textContent);

/** Puts the caret at the start or end of the (first line of the) first element matching sel. */
async function caret(p: Page, sel: string, atEnd = true) {
  await p.locator(sel).first().click();
  await p.waitForTimeout(100); // ProseMirror settles the click's selection shortly after mouseup
  await p.keyboard.press(atEnd ? "End" : "Home");
}

/** Extends the selection with Shift+Arrow. */
async function select(p: Page, key: "ArrowLeft" | "ArrowRight", n: number) {
  for (let i = 0; i < n; i++) await p.keyboard.press(`Shift+${key}`);
  await p.waitForTimeout(100); // selectionchange is async; let ProseMirror see the final selection
}

async function newNote(p: Page) {
  await p.getByRole("button", { name: "New note" }).click();
  await editor(p).click();
}

test("every format is reachable by markdown shortcut, key combo and toolbar", async ({ browser }) => {
  const p = await device(browser, newSecret());
  await newNote(p);
  const k = p.keyboard;
  for (const line of ["# Title", "## Two", "### Three", "Some **bold** *ital* `code` ~~gone~~ x", "- one", "", "1. first", "", "[] task", "", "> quote", ""])
    await (line ? k.type(line).then(() => k.press("Enter")) : k.press("Enter"));
  await k.type("---");
  await k.type("```");
  await k.press("Enter");
  await k.type("let x = 1");
  const md = await content(p);
  for (const s of [
    "<h1>Title</h1>", "<h2>Two</h2>", "<h3>Three</h3>", "<strong>bold</strong>", "<em>ital</em>", "<code>code</code>",
    "<s>gone</s>", "<ul><li><p>one</p></li></ul>", "<ol><li><p>first</p></li></ol>", 'data-type="taskList"',
    "<blockquote><p>quote</p></blockquote>", "<hr", "<pre><code>let x = 1</code></pre>",
  ]) expect(md).toContain(s);

  // Key combos: turn "x" (end of the bold line) into bold, then a link.
  await caret(p, ".ProseMirror h3 + p");
  await select(p, "ArrowLeft", 1);
  await k.press("ControlOrMeta+b");
  expect(await content(p)).toContain("<strong>x</strong>");
  p.once("dialog", (d) => d.accept("https://example.com"));
  await k.press("ControlOrMeta+k");
  expect(await content(p)).toContain('href="https://example.com"');

  // Toolbar, including a rejected javascript: link.
  await caret(p, ".ProseMirror h2");
  await p.getByRole("button", { name: /^Quote/ }).click();
  expect(await content(p)).toContain("<blockquote><h2>Two</h2></blockquote>");
  await caret(p, ".ProseMirror h1");
  p.once("dialog", (d) => d.accept("javascript:alert(1)"));
  await p.getByRole("button", { name: /^Link/ }).click();
  expect(await content(p)).not.toContain("javascript:");
});

test("sidebar title follows the first block live", async ({ browser }) => {
  const p = await device(browser, newSecret());
  await newNote(p);
  await p.keyboard.type("# Hello");
  await expect.poll(() => sidebarTitle(p)).toBe("Hello");
  await p.keyboard.type(" world");
  await expect.poll(() => sidebarTitle(p)).toBe("Hello world");
});

test("concurrent edits and formatting with one device offline converge", async ({ browser }) => {
  const secret = newSecret();
  const a = await device(browser, secret);
  await newNote(a);
  await a.keyboard.type("# Shared");
  await a.keyboard.press("Enter");
  await a.keyboard.type("Some text here");

  const b = await device(browser, secret);
  await b.locator("aside li button", { hasText: "Shared" }).click();
  await expect.poll(() => content(b)).toBe(await content(a));

  await b.evaluate(() => {
    const w = window as unknown as { __ws: WebSocket[]; __block: boolean };
    w.__block = true;
    w.__ws.forEach((s) => s.close());
  });
  await expect(b.locator("button.status")).toHaveText(/offline/i);

  // A edits online; B, offline, edits the same blocks and bolds "Some".
  await caret(a, ".ProseMirror h1");
  await a.keyboard.type(" A-edit");
  await caret(a, ".ProseMirror p");
  await a.keyboard.type(" tailA");
  await caret(b, ".ProseMirror h1", false);
  await b.keyboard.type("B-edit ");
  await caret(b, ".ProseMirror p", false);
  await select(b, "ArrowRight", 4);
  await b.keyboard.press("ControlOrMeta+b");
  expect(await content(a)).not.toContain("B-edit");

  await b.evaluate(() => {
    (window as unknown as { __block: boolean }).__block = false;
    dispatchEvent(new Event("online"));
  });
  await expect(b.locator("button.status")).toHaveText(/online/i);
  await expect.poll(async () => (await content(a)) === (await content(b)), { timeout: 15_000 }).toBe(true);
  const merged = await content(a);
  for (const s of ["B-edit Shared A-edit", "<strong>Some</strong>", "tailA"]) expect(merged).toContain(s);
});

test("phone width: bottom toolbar, no horizontal overflow", async ({ browser }) => {
  const p = await device(browser, newSecret());
  await p.setViewportSize({ width: 360, height: 740 });
  await newNote(p);
  const box = (await p.locator(".toolbar.format").boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(700);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("100k-word note opens and types without lag", async ({ browser }) => {
  const p = await device(browser, newSecret());
  await newNote(p);
  await editor(p).evaluate((ed) => {
    const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do".split(" ");
    let html = "<h1>Big</h1>";
    for (let i = 0; i < 1000; i++) html += `<p>${Array.from({ length: 100 }, (_, j) => words[(i + j) % 10]).join(" ")}</p>`;
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(p.locator(".ProseMirror p")).toHaveCount(1000);
  await expect.poll(() => sidebarTitle(p)).toBe("Big");
  await p.waitForTimeout(1500); // let the debounced IndexedDB save land

  await p.reload();
  const t0 = Date.now();
  await p.locator("aside li button", { hasText: "Big" }).click();
  await expect(p.locator(".ProseMirror p")).toHaveCount(1000, { timeout: 15_000 });
  const openMs = Date.now() - t0;

  await caret(p, ".ProseMirror p:nth-of-type(500)");
  const keyMs = await p.evaluate(async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      document.execCommand("insertText", false, "x");
      await new Promise(requestAnimationFrame);
      times.push(performance.now() - s);
    }
    return times.sort((x, y) => x - y)[10]!;
  });
  test.info().annotations.push({ type: "perf", description: `100k words: open ${openMs} ms, median keystroke ${keyMs.toFixed(1)} ms` });
  console.log(`perf: 100k words: open ${openMs} ms, median keystroke ${keyMs.toFixed(1)} ms`);
  expect(openMs).toBeLessThan(3000);
  expect(keyMs).toBeLessThan(50);
});

const tagInput = (p: Page) => p.getByLabel("Add tag", { exact: true });
const noteTags = (p: Page) => p.locator(".tagbar .chip").allTextContents();
const sideTag = (p: Page, name: string) => p.locator("nav.tags .chip", { hasText: `#${name}` });
const listed = (p: Page) => p.locator("aside li button").evaluateAll((els) => els.map((e) => e.firstChild!.textContent).sort());

async function tag(p: Page, name: string) {
  await tagInput(p).fill(name);
  await tagInput(p).press("Enter");
}

test("tags: add, autocomplete, AND filter, rename, delete", async ({ browser }) => {
  const p = await device(browser, newSecret());
  await newNote(p);
  await p.keyboard.type("Alpha");
  await tag(p, "Ideas");
  await tag(p, "#ideas"); // same tag, case-insensitive
  await expect.poll(() => noteTags(p)).toEqual(["ideas×"]);
  await newNote(p);
  await p.keyboard.type("Beta");
  await expect(p.locator("#tag-suggestions option[value=ideas]")).toHaveAttribute("label", "1 note");
  await tag(p, "ideas");
  await tag(p, "home");
  await expect.poll(() => noteTags(p)).toEqual(["home×", "ideas×"]);
  await p.getByRole("button", { name: "Remove tag home" }).click();
  await expect.poll(() => noteTags(p)).toEqual(["ideas×"]);
  await tag(p, "home");

  await sideTag(p, "ideas").click();
  await expect.poll(() => listed(p)).toEqual(["Alpha", "Beta"]);
  await sideTag(p, "home").click();
  await expect.poll(() => listed(p)).toEqual(["Beta"]);
  await expect(p.locator(".filter strong")).toHaveText("#ideas + #home");
  await sideTag(p, "home").click();

  p.once("dialog", (d) => d.accept("Thoughts"));
  await p.locator(".filter").getByRole("button", { name: "Rename" }).click();
  await expect.poll(() => noteTags(p)).toEqual(["home×", "thoughts×"]);
  await expect(sideTag(p, "thoughts")).toContainText("2");
  await expect(sideTag(p, "thoughts")).toHaveAttribute("aria-pressed", "true");

  p.once("dialog", (d) => d.accept());
  await p.locator(".filter").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => noteTags(p)).toEqual(["home×"]);
  await expect(sideTag(p, "thoughts")).toHaveCount(0);
  await expect.poll(() => listed(p)).toEqual(["Alpha", "Beta"]);
});

test("tags: two devices tagging the same note offline both keep their tag", async ({ browser }) => {
  const secret = newSecret();
  const a = await device(browser, secret);
  await newNote(a);
  await a.keyboard.type("Shared");
  const b = await device(browser, secret);
  await b.locator("aside li button", { hasText: "Shared" }).click();
  await b.evaluate(() => {
    const w = window as unknown as { __ws: WebSocket[]; __block: boolean };
    w.__block = true;
    w.__ws.forEach((s) => s.close());
  });
  await expect(b.locator("button.status")).toHaveText(/offline/i);

  await tag(a, "from-a");
  await tag(b, "from-b");
  await b.evaluate(() => {
    (window as unknown as { __block: boolean }).__block = false;
    dispatchEvent(new Event("online"));
  });
  for (const p of [a, b]) await expect.poll(() => noteTags(p), { timeout: 15_000 }).toEqual(["from-a×", "from-b×"]);
});

const navItem = (p: Page, name: string) => p.locator("nav.folders .nav-item", { hasText: name });
const crumbs = (p: Page) => p.locator(".crumbs").innerText();
const header = (p: Page) => p.locator(".list-header");

async function newFolder(p: Page, name: string, where: "sidebar" | "here" = "sidebar") {
  await (where === "sidebar" ? p.getByRole("button", { name: "New folder", exact: true }).first() : header(p).getByRole("button", { name: "New folder" })).click();
  await expect(p.locator(".name-input input")).toBeFocused();
  await p.keyboard.type(name);
  await p.keyboard.press("Enter");
}

test("folders: create, nest, breadcrumb, rename, delete, and sync to another device", async ({ browser }) => {
  const secret = newSecret();
  const p = await device(browser, secret);
  await newNote(p);
  await p.keyboard.type("Loose");
  await expect(navItem(p, "Unfiled")).toContainText("1");

  await newFolder(p, "Work");
  await expect(navItem(p, "Work")).toHaveAttribute("aria-current", "page");
  await newNote(p);
  await p.keyboard.type("In work");
  await newFolder(p, "Projects", "here");
  await p.locator("button.folder-row", { hasText: "Projects" }).click();
  await expect.poll(() => crumbs(p)).toBe("Work / Projects");
  await expect(navItem(p, "Work")).toHaveAttribute("aria-current", "page"); // the sidebar shows the top-level folder
  await newNote(p);
  await p.keyboard.type("Deep");

  // A clashing name is flagged and can't be saved; Esc cancels.
  await newFolder(p, "Other");
  await p.getByRole("button", { name: "New folder", exact: true }).first().click();
  await expect(p.getByLabel("New folder name")).toBeFocused();
  await p.keyboard.type("work");
  await expect(p.getByLabel("New folder name")).toHaveAttribute("aria-invalid", "true");
  await p.keyboard.press("Enter");
  await expect(p.locator("nav.folders .nav-item")).toHaveCount(4); // All notes, Unfiled, Work, Other: nothing added
  await p.keyboard.press("Escape");
  await expect(p.getByLabel("New folder name")).toHaveCount(0);

  await navItem(p, "Work").click();
  await header(p).getByRole("button", { name: "Rename" }).click();
  await expect(p.getByLabel("Folder name")).toBeFocused();
  await p.keyboard.type("Job");
  await p.keyboard.press("Enter");
  await expect.poll(() => crumbs(p)).toBe("Job");

  // The other device sees the tree.
  const b = await device(browser, secret);
  await navItem(b, "Job").click();
  await expect(b.locator("button.folder-row", { hasText: "Projects" })).toContainText("1 note");
  await expect(b.locator("aside li button", { hasText: "In work" })).toBeVisible();

  // Deleting Job moves its note and subfolder to the top level / Unfiled.
  p.once("dialog", (d) => {
    expect(d.message()).toContain("Its 1 note moves to Unfiled and its 1 subfolder moves to the top level, so nothing is lost.");
    void d.accept();
  });
  await header(p).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => crumbs(p)).toBe("Unfiled");
  await expect(navItem(p, "Unfiled")).toContainText("2");
  await expect(navItem(b, "Job")).toHaveCount(0, { timeout: 15_000 });
  await expect(navItem(b, "Projects")).toBeVisible();
  await expect.poll(() => crumbs(b)).toBe("All notes"); // b had Job open
});
