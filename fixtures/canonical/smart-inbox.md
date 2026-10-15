---
ore: true
name: Smart Inbox Processor
version: "0.1"
author: VaultOre Team
description: |
  Files the open items of an inbox note into one note per category,
  sorted by a single AI call, then ticks the items it filed.

tags: [demo, inbox, ai]

# To run it every weekday morning, uncomment the schedule. It calls the AI
# provider on every run, even when the inbox has no open items (see "Not yet").
# schedule: "0 9 * * 1-5"

runtime:
  image: oven/bun:1-alpine
  timeout: 120

permissions:
  network: allow     # the AI cell calls the provider
  vaultRead: allow   # reads the inbox and existing category notes
  vaultWrite: allow  # writes the category notes and ticks the inbox
---

# Smart Inbox Processor

Reads the open items (`- [ ] …`) of an inbox note, asks the AI once which
category each belongs to, and appends each item to that category's note in a
folder (`Processed/Work.md`, `Processed/Personal.md`, …). Only after those notes
are written does it tick the filed items in the inbox (`- [ ]` → `- [x]`); every
other line of the inbox stays exactly as it was. Ticked items are not picked up
again, so running it twice does not file anything twice.

The inbox path, the target folder and the categories are set at the top of the
first cell. The default inbox is `Inbox.md` at the vault root.

**Not yet.** This version uses only what the engine supports today. The full
design needs engine features that are planned in
[#80](https://github.com/cronai-labs/vaultore/issues/80): conditions (`runIf`,
`when=`) to skip the AI call when the inbox has no open items, structured
outputs (`{{cell.field}}`, JSON-mode AI cells) instead of the hand-rendered
prompt and hand-checked answer below, and a `skipped` cell status to report
"nothing to do" without running every cell.

## Step 1: Read the inbox

Settings live here. Each open item gets a number, and the cell remembers its
exact line so the last step can find it again.

```ore:ts id=readInbox
// Settings: change them here, every later cell reads them from this output.
const INBOX_PATH = "Inbox.md"; // the note to process, relative to the vault root
const NOTES_FOLDER = "Processed"; // where the category notes go
const CATEGORIES = {
  work: "Professional tasks, meetings, deadlines",
  personal: "Life admin, health, relationships, hobbies",
  reference: "Things to read, watch, or keep for later",
};

if (!(await vault.exists(INBOX_PATH))) {
  throw new Error(`Inbox note not found: ${INBOX_PATH}. Set INBOX_PATH at the top of readInbox.`);
}
const text = await vault.read(INBOX_PATH);

// An open item is a list line with an unchecked box and some text, such as
// "- [ ] Call mum", also with "*" or "+" bullets and indented.
const OPEN_ITEM = /^\s*[-*+] \[ \] +(\S.*)$/;
const seen = new Map(); // exact line -> how often it occurred so far
const items = [];
for (const line of text.split("\n")) {
  const match = OPEN_ITEM.exec(line.replace(/\r$/, ""));
  if (!match) continue;
  const occurrence = seen.get(line) ?? 0;
  seen.set(line, occurrence + 1);
  items.push({ id: items.length + 1, text: match[1].trim(), line, occurrence });
}

const inbox = { inboxPath: INBOX_PATH, notesFolder: NOTES_FOLDER, categories: CATEGORIES, items };
inbox;
```

## Step 2: Write the prompt

An AI cell can only insert a whole cell output (`{{prompt}}`), so this cell
renders the categories, the numbered items and the answer shape as text.

```ore:ts id=prompt depends=[readInbox]
const { categories, items } = cell("readInbox");
const keys = Object.keys(categories);
const example = Object.fromEntries(
  keys.map((key, i) => [key, i === 0 ? [1, 3] : i === 1 ? [2] : []])
);

const lines = [
  "Categories:",
  ...keys.map((key) => `- ${key}: ${categories[key]}`),
  "",
  "Items:",
  ...(items.length > 0 ? items.map((item) => `${item.id}. ${item.text}`) : ["(none)"]),
  "",
  "Answer shape (an example, not the answer):",
  JSON.stringify(example),
];
lines.join("\n");
```

## Step 3: Categorise

One AI call for all items. It answers with item numbers, not item text, so a
reworded item cannot go missing.

```ore:ai id=categorize depends=[prompt] temperature=0
You sort a person's inbox. Put every numbered item below into exactly one of the categories.

{{prompt}}

Answer with one JSON object and nothing else: no prose, no code fence. It has exactly one key per category, each holding a list of item numbers. Every item number appears exactly once. Use [] for a category with no items.
```

## Step 4: Check the answer

Strict on purpose: anything but a JSON object that puts every item into exactly
one known category fails this cell, so nothing below runs and the inbox stays
as it was.

```ore:ts id=parseAnswer depends=[readInbox, categorize]
const { categories, items } = cell("readInbox");
const raw = String(cell("categorize")).trim();
const byCategory = Object.fromEntries(Object.keys(categories).map((key) => [key, []]));
const said = `It said: ${raw.slice(0, 300)}`;

// With no open items there is nothing the answer could place, so it is not read.
if (items.length > 0) {
  // Models often wrap JSON in a code fence even when asked not to; accept one.
  const fenced = /^\x60{3}(?:json)?\n([\s\S]*)\n\x60{3}$/.exec(raw);
  let answer;
  try {
    answer = JSON.parse(fenced ? fenced[1] : raw);
  } catch {
    throw new Error(`categorize did not answer with JSON. ${said}`);
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw new Error(`categorize did not answer with a JSON object. ${said}`);
  }

  const placed = new Map(); // item number -> category
  for (const [key, ids] of Object.entries(answer)) {
    if (!(key in byCategory)) {
      throw new Error(`categorize used an unknown category "${key}" (expected ${Object.keys(byCategory).join(", ")}). ${said}`);
    }
    if (!Array.isArray(ids)) {
      throw new Error(`categorize: "${key}" is not a list of item numbers. ${said}`);
    }
    for (const id of ids) {
      if (!Number.isInteger(id) || !items[id - 1]) {
        throw new Error(`categorize: "${key}" lists ${JSON.stringify(id)}, which is not an item number (1-${items.length}). ${said}`);
      }
      if (placed.has(id)) {
        throw new Error(`categorize: item ${id} (${items[id - 1].text}) is in both "${placed.get(id)}" and "${key}". ${said}`);
      }
      placed.set(id, key);
      byCategory[key].push(items[id - 1]);
    }
  }
  for (const key of Object.keys(byCategory)) {
    if (!(key in answer)) throw new Error(`categorize left out the category "${key}". ${said}`);
  }
  for (const item of items) {
    if (!placed.has(item.id)) {
      throw new Error(`categorize: item ${item.id} (${item.text}) was not categorised. ${said}`);
    }
  }
}

const sorted = { byCategory };
sorted;
```

## Step 5: Write the category notes

One note per category in the folder. A note that exists is appended to, never
rewritten, and keeps its frontmatter; a new one gets OKF frontmatter.

```ore:ts id=writeNotes depends=[readInbox, parseAnswer]
const { notesFolder } = cell("readInbox");
const { byCategory } = cell("parseAnswer");

// ISO 8601 with the UTC offset of the container's clock, e.g. 2026-10-15T09:00:00+00:00.
function isoWithOffset(date) {
  const offset = -date.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
}
const now = isoWithOffset(new Date());

const written = [];
for (const [key, items] of Object.entries(byCategory)) {
  if (items.length === 0) continue;
  const title = key.charAt(0).toUpperCase() + key.slice(1);
  const path = `${notesFolder}/${title}.md`;
  const section = [`## From the inbox, ${now}`, "", ...items.map((item) => `- [ ] ${item.text}`), ""].join("\n");

  if (await vault.exists(path)) {
    const existing = await vault.read(path);
    const gap = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    await vault.write(path, existing + gap + section);
  } else {
    const frontmatter = [
      "---",
      "type: Task List",
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(`Inbox items the smart-inbox workflow filed under ${key}.`)}`,
      "generated:",
      "  by: process:smart-inbox",
      `  at: ${JSON.stringify(now)}`,
      "---",
    ].join("\n");
    await vault.mkdirp(notesFolder);
    await vault.write(path, `${frontmatter}\n\n# ${title}\n\n${section}`);
  }
  written.push({ category: key, path, items });
}
written;
```

## Step 6: Tick the filed items

Runs only after the notes exist. The inbox is read again, since it may have
changed while the AI cell ran, and each item is found by its exact original
line, so lines added or removed elsewhere do not matter. An item whose line was
edited or removed is left alone and reported under `notTicked`. Every other
line is written back byte for byte.

```ore:ts id=tickInbox depends=[readInbox, writeNotes]
const { inboxPath } = cell("readInbox");
const filed = cell("writeNotes").flatMap((note) => note.items);

const lines = (await vault.read(inboxPath)).split("\n");
const where = new Map(); // exact line -> the indexes where it occurs now
lines.forEach((line, index) => where.set(line, [...(where.get(line) ?? []), index]));

const notTicked = [];
let ticked = 0;
for (const item of filed) {
  const index = where.get(item.line)?.[item.occurrence];
  if (index === undefined) {
    notTicked.push(item.text);
    continue;
  }
  lines[index] = lines[index].replace("[ ]", "[x]");
  ticked += 1;
}
if (ticked > 0) await vault.write(inboxPath, lines.join("\n"));

const result = { inbox: inboxPath, ticked, notTicked };
result;
```
