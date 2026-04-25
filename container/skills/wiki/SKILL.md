---
name: wiki
description: Ingest sources into the knowledge wiki, query the wiki, or run a lint health check. Use when the user wants to add material, ask questions against accumulated knowledge, or maintain wiki health.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# /wiki — Personal Knowledge Wiki

The wiki is a persistent, compounding knowledge base. Raw sources are filed in
`/workspace/agent/sources/`. The wiki itself lives in `/workspace/agent/wiki/`.
You own the wiki entirely — create, update, cross-reference, synthesize.

Two special files:
- `wiki/index.md` — content catalog; read first on every query; update on every ingest
- `wiki/log.md` — append-only activity log; add an entry for every operation

---

## Operation: ingest

Triggered when the user provides a source (file path, URL, or drops a file).

**CRITICAL — process one source at a time.** If the user points at a folder or
provides multiple files, confirm before proceeding. For each source, fully complete
all wiki work before touching the next source.

### Per-source workflow

1. **Acquire full content**
   - *File in sources/*: Read it directly.
   - *URL (article/page)*: Download full content — do NOT use WebFetch (it returns
     a summary, not the full document):
     ```bash
     # HTML page
     curl -sL "URL" -o /workspace/agent/sources/filename.html
     # or for JS-rendered pages, use agent-browser if available
     
     # PDF
     curl -sL "URL" -o /workspace/agent/sources/filename.pdf
     ```
     Then Read the downloaded file.
   - *PDF already in sources/*: Read tool handles PDFs natively (up to 20 pages per
     request; use offset/limit for long documents).
   - *Transcript (text file)*: Read directly from sources/.

2. **Discuss with the user** — share key takeaways, what surprised you, what connects
   to things already in the wiki. This is the synthesis moment; don't skip it.

3. **Write/update wiki pages** — typical ingest touches 5–15 pages:
   - Summary page for this source (`wiki/sources/<slug>.md`)
   - Entity pages for people, organizations, projects mentioned
   - Concept pages for ideas, frameworks, techniques introduced
   - Comparison or synthesis pages if this source updates or contradicts existing ones
   - Cross-reference: add links from related existing pages to the new ones
   - Update `wiki/index.md` — add all new pages under the correct category
   - Append to `wiki/log.md`:
     ```
     ## [YYYY-MM-DD] ingest | <Source Title>
     Pages created: X. Pages updated: Y. Key entities: ...
     ```

4. Tell the user what you created and what cross-references you made.

### File naming

- Source summaries: `wiki/sources/<slug>.md` (kebab-case, descriptive)
- Entity pages: `wiki/people/<name>.md`, `wiki/orgs/<name>.md`, `wiki/projects/<name>.md`
- Concept pages: `wiki/concepts/<name>.md`
- Syntheses: `wiki/syntheses/<topic>.md`
- Free-form: anywhere under `wiki/` that fits

---

## Operation: query

Triggered when the user asks a question against accumulated knowledge.

1. Read `wiki/index.md` to find relevant pages.
2. Open the pages that look relevant (may cascade — follow cross-references).
3. Synthesize an answer; cite pages by title/path.
4. If the answer is substantive and reusable, offer to file it back into the wiki
   as a new synthesis page. Good answers compound.
5. Append to `wiki/log.md`:
   ```
   ## [YYYY-MM-DD] query | <Question summary>
   Pages consulted: X. New page created: yes/no.
   ```

---

## Operation: lint

Triggered when the user asks for a wiki health check (or on schedule).

Check for:
- **Orphan pages** — pages with no inbound links from other wiki pages
- **Stale content** — claims that newer sources have superseded
- **Missing cross-references** — entities mentioned in multiple pages without links
- **Contradictions** — conflicting claims across pages; flag but don't silently resolve
- **Index gaps** — pages that exist but aren't in `wiki/index.md`
- **Source gaps** — topics the wiki covers thinly; suggest sources to pursue

Report findings. Offer to fix mechanical issues (orphans, missing cross-references,
index gaps) immediately. Flag contradictions and stale content for the user to review.

Append to `wiki/log.md`:
```
## [YYYY-MM-DD] lint | Health check
Issues found: X. Auto-fixed: Y. Needs review: Z.
```
