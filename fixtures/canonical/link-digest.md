---
ore: true
name: Link Digest
version: "0.1"
author: VaultOre Team
tags: [canonical, primary, research, automation]
description: >
  Primary use case workflow. Fetches URLs, summarizes with AI,
  creates digest notes with backlinks.

runtime:
  engine: docker
  image: oven/bun:1-alpine

permissions:
  network: allow      # Required for fetching URLs and AI
  vaultWrite: allow   # Required for creating notes
  vaultRead: allow
---

# Link Digest Workflow

This is the **primary use case** that validates VaultOre's core value proposition.

## Test Criteria

- [ ] Config cell provides parameters
- [ ] URL extraction works from seed note
- [ ] HTTP fetch succeeds (requires network)
- [ ] AI summarization produces valid JSON
- [ ] Artifact files are created
- [ ] (Optional) Notes are created with backlinks

---

## Configuration

```ore:ts id=config
// Workflow configuration
const config = {
  seedNote: "Inbox/reading.md",
  outputFolder: "Digests",
  artifactDir: `${vaultore.outputRoot}/artifacts/link-digest`,
  maxUrls: 5,
};

config;
```

---

## Step 1: Extract URLs from seed note

```ore:ts id=extract-urls depends=[config]
const config = cell("config");
// Try to read the seed note, or use sample data
let noteContent;
try {
  noteContent = await vault.read(config.seedNote);
} catch {
  // Sample data for testing
  noteContent = `
# Reading List

Some articles to read:
- https://example.com/article-1
- https://example.com/article-2
- https://news.ycombinator.com
`;
}

// Extract URLs with regex
const urlRegex = /https?:\/\/[^\s)>\]]+/g;
const urls = [...new Set(noteContent.match(urlRegex) || [])];

// Limit to configured max
const limitedUrls = urls.slice(0, config.maxUrls);

({
  seedNote: config.seedNote,
  totalFound: urls.length,
  processing: limitedUrls.length,
  urls: limitedUrls,
});
```

---

## Step 2: Fetch content from URLs

```ore:ts id=fetch-pages depends=[extract-urls]
const urls = cell("extract-urls").urls;

async function fetchOne(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "VaultOre/0.1" },
    });

    if (!response.ok) {
      return { url, error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "Untitled";

    // Extract hostname
    const hostname = new URL(url).hostname;

    // Simple text extraction (truncated for AI context)
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);

    return { url, hostname, title, text };
  } catch (e) {
    return { url, error: String(e.message || e) };
  }
}

const pages = await Promise.all(urls.map(fetchOne));
const successful = pages.filter((p) => !p.error);
const failed = pages.filter((p) => p.error);

({
  fetchedAt: new Date().toISOString(),
  total: pages.length,
  successful: successful.length,
  failed: failed.length,
  pages,
});
```

---

## Step 3: Summarize with AI

```ore:ai id=summarize model=claude-sonnet-4-20250514 temperature=0 maxTokens=1200 depends=[fetch-pages]
You are a research assistant helping organize reading material.

For each page below (that doesn't have an error), provide:
1. A one-sentence summary
2. Three key themes/topics
3. A relevance score from 1-5

Return JSON only (no code fences, no commentary) with this exact structure:
{
  "items": [
    {
      "url": "...",
      "title": "...",
      "summary": "One sentence summary",
      "themes": ["theme1", "theme2", "theme3"],
      "relevance": 4
    }
  ],
  "meta": {
    "processedAt": "ISO timestamp",
    "totalProcessed": number
  }
}

For pages with errors, include them with null summary and empty themes.

Pages to process:
{{fetch-pages}}
```

---

## Step 4: Write artifacts

```ore:ts id=write-artifacts depends=[summarize, config]
const config = cell("config");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const baseDir = `${config.artifactDir}/${runId}`;

// Parse AI response
let summaries;
try {
  summaries = JSON.parse(cell("summarize"));
} catch {
  summaries = {
    items: [],
    meta: { error: "Failed to parse AI response" },
  };
}

const fetchData = cell("fetch-pages");

// Create artifact directory
await vault.mkdirp(baseDir);

// Write summaries
await vault.write(
  `${baseDir}/summaries.json`,
  JSON.stringify(summaries, null, 2)
);

// Write raw fetch data
await vault.write(
  `${baseDir}/fetch-data.json`,
  JSON.stringify(fetchData, null, 2)
);

// Write README
const readme = `# Link Digest Artifacts

Generated: ${new Date().toISOString()}
Seed Note: ${config.seedNote}
URLs Processed: ${fetchData.total}

## Files

- \`summaries.json\` - AI-generated summaries and themes
- \`fetch-data.json\` - Raw fetched page data
`;
await vault.write(`${baseDir}/README.md`, readme);

({
  artifactDir: baseDir,
  files: [
    `${baseDir}/summaries.json`,
    `${baseDir}/fetch-data.json`,
    `${baseDir}/README.md`,
  ],
  itemCount: summaries.items?.length || 0,
});
```

---

## Step 5: Create digest note (optional)

```ore:ts id=create-digest depends=[summarize, write-artifacts, config]
const config = cell("config");
const summaries = JSON.parse(cell("summarize"));
const artifacts = cell("write-artifacts");
const today = new Date().toISOString().split("T")[0];

// Generate markdown digest
const digest = `# Reading Digest - ${today}

> Generated by VaultOre from [[${config.seedNote}]]

## Summary

${summaries.items?.length || 0} articles processed.

---

${(summaries.items || [])
  .filter((s) => s.summary)
  .map(
    (s, i) => `
### ${i + 1}. ${s.title || "Article"}

**URL:** ${s.url}
**Relevance:** ${"⭐".repeat(s.relevance || 3)}

${s.summary}

**Themes:** ${(s.themes || []).join(", ")}
`
  )
  .join("\n---\n")}

---

## Metadata

- Source: [[${config.seedNote}]]
- Generated: ${new Date().toISOString()}
- Artifacts: \`${artifacts.artifactDir}\`
`;

// Write digest
const digestPath = `${config.outputFolder}/digest-${today}.md`;
await vault.mkdirp(config.outputFolder);
await vault.write(digestPath, digest);

({
  status: "success",
  digestPath,
  contentLength: digest.length,
  articlesIncluded: summaries.items?.filter((s) => s.summary).length || 0,
});
```

---

## Expected Results

After running successfully:

1. **Artifacts created** in `_vaultore/artifacts/link-digest/<timestamp>/` (default output folder)
   - `summaries.json` - AI output
   - `fetch-data.json` - Raw fetch results
   - `README.md` - Artifact metadata

2. **Digest note created** at `Digests/digest-<date>.md`
   - Contains formatted summaries
   - Links back to seed note
   - Star ratings for relevance

3. **All outputs** persisted as ore-output callouts below each cell

## Test Validation

```bash
# Check artifact files exist
test -f "_vaultore/artifacts/link-digest/*/summaries.json"
test -f "_vaultore/artifacts/link-digest/*/fetch-data.json"

# Check digest note exists
test -f "Digests/digest-*.md"

# Validate JSON outputs
jq . "_vaultore/artifacts/link-digest/*/summaries.json"
```
