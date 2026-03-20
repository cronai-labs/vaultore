---
ore: true
name: Smart Inbox Processor
version: "0.2"
author: VaultOre Team
description: |
  Demonstrates semantic conditions (v0.2+).
  Processes inbox items only when there's meaningful work to do.
  
tags: [demo, semantic-conditions, inbox]

schedule: "0 9 * * 1-5"  # Weekdays at 9am
runIf: "{{ai: the inbox note contains at least one unchecked item marked with [ ]}}"

runtime:
  engine: docker
  image: oven/bun:1-alpine
  timeout: 120

permissions:
  network: allow
  vaultRead: allow
  vaultWrite: allow
---

# Smart Inbox Processor

This workflow demonstrates VaultOre's semantic conditions feature.

**What it does:**
1. Checks if the inbox has unprocessed items (semantic condition)
2. Loads the inbox content
3. Skips categorization if there are fewer than 3 items (cell-level condition)
4. Uses AI to categorize items
5. Creates organized notes for each category

## Step 1: Load Inbox

```ore:ts id=loadInbox
// Load the inbox note or use sample data
let inbox;
try {
  inbox = await vault.read("Inbox.md");
} catch {
  inbox = `- [ ] Sample task one
- [ ] Sample task two
- [ ] Sample task three`;
}

// Extract unchecked items
const items = inbox.match(/- \[ \] .+/g) || [];

// Return structured data
JSON.stringify({
  raw: inbox,
  items: items.map(i => i.replace('- [ ] ', '')),
  count: items.length
});
```

## Step 2: Extract and Parse

```ore:ts id=parseItems depends=[loadInbox]
const data = JSON.parse(cell("loadInbox"));

// Log what we found
console.log(`Found ${data.count} items to process`);

data;
```

## Step 3: AI Categorization

This cell only runs if there are enough items to categorize.

```ore:ai id=categorize depends=[parseItems] when="{{ai: the item count is 3 or more}}"
You are a personal assistant helping organize an inbox.

Categorize these items into exactly three categories:
- **Work**: Professional tasks, meetings, deadlines
- **Personal**: Life admin, health, relationships, hobbies
- **Reference**: Things to read, watch, or save for later

Items to categorize:
{{parseItems.items}}

Return ONLY a JSON object in this exact format:
{
  "work": ["item1", "item2"],
  "personal": ["item3"],
  "reference": ["item4", "item5"]
}
```

## Step 4: Create Category Notes

```ore:ts id=createNotes depends=[categorize]
const categories = JSON.parse(cell("categorize"));
const date = new Date().toISOString().split('T')[0];

const results = [];

for (const [category, items] of Object.entries(categories)) {
  if (items.length === 0) continue;
  
  const title = category.charAt(0).toUpperCase() + category.slice(1);
  const filename = `Processed/${title}/${date}.md`;
  
  const content = `---
created: ${new Date().toISOString()}
source: Inbox
category: ${category}
---

# ${title} Items - ${date}

${items.map(item => `- [ ] ${item}`).join('\n')}

---
*Processed by VaultOre Smart Inbox*
`;
  
  await vault.mkdirp(`Processed/${title}`);
  await vault.write(filename, content);
  
  results.push({ category, count: items.length, file: filename });
}

JSON.stringify(results, null, 2);
```

## Step 5: Update Inbox

```ore:ts id=updateInbox depends=[createNotes, loadInbox]
const original = JSON.parse(cell("loadInbox")).raw;
const processed = JSON.parse(cell("createNotes"));

// Mark processed items as done
let updated = original;
for (const item of processed.flatMap(p => p.items || [])) {
  updated = updated.replace(`- [ ] ${item}`, `- [x] ${item} ✅`);
}

// Add processing note
const timestamp = new Date().toISOString();
updated += `\n\n---\n*Last processed: ${timestamp}*\n`;

await vault.write("Inbox.md", updated);

`Inbox updated. Processed ${processed.length} categories.`;
```
