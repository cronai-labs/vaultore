# Local Intelligence (RAG) Strategy

> **Status:** Exploration. Nothing in this document is built; the APIs below are proposals.  
> **Goal:** Improve AI quality using local, permissioned context  
> **Roadmap:** [under consideration](roadmap.md#under-consideration)

VaultOre should provide **local intelligence** that helps AI cells answer with higher accuracy and lower hallucination risk. The core idea is a vault-local retrieval system (RAG) that can be used by workflows without sending unnecessary data to external providers.

---

## 1. Goals

- **Local-first:** Index lives in the vault and works offline
- **Permissioned:** No data leaves the vault unless the workflow allows it
- **Composable:** Usable by `ore:ai`, `ore:ts`, and future UI tools
- **Incremental:** Updates on file changes and workflow runs
- **Auditable:** Sources and excerpts are visible and attributable

---

## 2. Architecture Overview

### 2.1 Data Sources

- **Vault notes** (markdown content, frontmatter, tags)
- **Workflow outputs** (from `_vaultore/runs/...`)
- **Artifacts** (optional, when files are marked for indexing)
- **Metadata** (file paths, timestamps, links, tags)

### 2.2 Indexing Pipeline

1. **Ingest:** Parse files into chunks (notes, outputs, artifacts)
2. **Embed:** Create vector embeddings per chunk
3. **Store:** Persist to local vector DB
4. **Retrieve:** Query by text with optional filters

### 2.3 Storage Options (Local)

- SQLite + vector extension (fast, portable)
- LanceDB (simple local vector store)
- Alternative: JSONL + HNSW in WASM (portable, slower)

---

## 3. Runtime APIs (Proposed)

### 3.1 Template Helpers

- `{{retrieve: query=... k=5}}`  
  Injects top‑k snippets into an AI prompt

### 3.2 Vault API (TypeScript)

```ts
const hits = await vault.search({
  query: "project timeline",
  limit: 5,
  include: ["notes", "outputs"],
  tags: ["roadmap"],
});
```

### 3.3 Output Attribution

Each retrieval result should include:
- `path`
- `chunkId`
- `score`
- `excerpt`

So users can inspect and audit what the model saw.

---

## 4. Privacy & Permissions

- Retrieval **uses local data only** by default
- Sending retrieved text to an AI provider stays under the existing `network` and `vaultRead`
  permissions ([permissions spec](../specs/permissions-spec.md))
- Workflows can opt‑out of retrieval entirely
- All retrieved snippets are visible in the note/output

---

## 5. Possible Phases

An order, not a schedule:

1. Basic indexing of notes; a local search API for `ore:ai`
2. Index workflow outputs and selected artifacts; retrieval filters (tags, folders, modified
   time)
3. Optional local model embeddings (Ollama / LM Studio); per-workflow retrieval settings
4. Semantic diffing across workflow runs; suggestions based on what changed

---

## 6. Testing Strategy

Add a canonical fixture that:
- Writes a note
- Runs a workflow that queries it
- Verifies retrieved snippets appear in the AI prompt

---

## 7. Open Questions

- Do we index all outputs by default, or only those marked?
- Which vector store is easiest for bundling in Obsidian?
- Should embeddings be per‑vault or per‑workspace?
- How to handle large binary artifacts (PDFs, images)?

---

**Next:** If approved, add a minimal local indexer + retrieval API and wire into `ore:ai` prompts.
