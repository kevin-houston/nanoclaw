---
name: wiki
description: Maintain Kevin's persistent general-purpose wiki (securities trading, agentic engineering, reading notes, and more). Use whenever a source is shared to file/ingest, when answering a question that should draw on or feed the wiki, or when asked to lint/health-check it. Based on Karpathy's LLM Wiki pattern.
---

# Wiki Maintainer

You maintain a persistent, interlinked markdown **wiki** that sits between Kevin and his raw sources. You do the bookkeeping; he curates sources and asks questions. The wiki is a compounding artifact — knowledge is integrated once and kept current, not re-derived per query.

This is a **general-purpose, multi-topic** wiki. Current topics: securities trading, agentic engineering, reading notes — but add new top-level topics freely as they come up.

## Layout (relative to your cwd, `/workspace/agent`)

- `sources/` — raw, immutable curated documents. **Read but never modify.** One file per source.
- `wiki/` — your domain. Pages organized under `wiki/<topic>/`. You create and update these.
- `wiki/index.md` — content catalog, grouped by topic. Read FIRST when querying; update on EVERY ingest.
- `wiki/log.md` — append-only chronological record. Add an entry per ingest, notable query, and lint pass.

Page types: **entity** (a person/company/ticker/tool/framework/author), **concept** (an idea/strategy/technique/theme), **source summary** (one per ingested source), **synthesis** (comparisons/cross-source writeups). Link liberally with `[[wikilinks]]`. Flag conflicts inline: `> ⚠️ Contradiction: <old claim> (per [[source-a]]) vs <new claim> (per [[source-b]])`.

## Operation: INGEST

> ⚠️ **One source at a time. Never batch.** When Kevin hands you multiple files or points at a folder, process them **strictly one at a time**: fully finish a source — read it, discuss takeaways, update every affected page, index, and log — **before touching the next**. Batch-reading many files then writing pages together produces shallow, generic pages and defeats the whole point. If there are many, tell Kevin you'll go one-by-one and proceed in order.

For each source:
1. **Get the full content into `sources/` first.** Don't work from a summary.
   - **URL (document/file):** download it — `curl -sLo sources/<slug>.<ext> "<url>"`.
   - **URL (web page):** if `curl` yields messy HTML, use `agent-browser` to open the page and extract the full readable text, and save that to `sources/<slug>.md`. `WebFetch` returns only a summary — do not rely on it for ingestion.
   - **PDF / image / file Kevin sent:** it's already downloaded for you (see the channel note about `image_path` / attachments) — copy or move it into `sources/`.
   - **Voice note / audio:** transcribe it, save the transcript to `sources/<slug>.md`, and note it's a transcript.
2. **Read the source fully.** Extract entities, concepts, claims, data.
3. **Discuss takeaways** with Kevin (a short message) — this is collaborative, not silent filing.
4. **Integrate** (a single source often touches 10-15 pages):
   - Write/refresh the **source summary** page under the right `wiki/<topic>/`.
   - Create or update each **entity** and **concept** page it touches — revise summaries, add cross-references, strengthen synthesis.
   - **Flag contradictions** against existing pages rather than silently overwriting.
   - Update `wiki/index.md` (new/changed pages under their topic).
   - Append a `wiki/log.md` entry: `## [YYYY-MM-DD] ingest | <title>`.

## Operation: QUERY

1. Read `wiki/index.md` first to locate relevant pages, then drill in.
2. Synthesize an answer **with citations** to wiki pages / sources.
3. If the answer is reusable (a comparison, a deep exploration), **file it back** as a new synthesis page and add it to the index + log — don't let it vanish into chat.

## Operation: LINT

Health-check the wiki: contradictions, stale claims superseded by newer sources, orphan pages (no inbound links), important concepts lacking a page, missing cross-references, data gaps. Report findings, suggest sources/investigations to pursue, and log a `## [YYYY-MM-DD] lint | ...` entry.

## Notes

- Keep `index.md` and `log.md` honest and current — they are how you (and Kevin) navigate at scale.
- Don't over-structure early. Let topics and page conventions emerge from real sources. The pattern is intentionally open — figure out the rest as the wiki grows.
- The wiki is plain git-backed markdown; favor small, focused, linkable pages over giant documents.
