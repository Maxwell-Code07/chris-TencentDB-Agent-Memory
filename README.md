[中文](README_CN.md)

<h1 align="center">TencentDB Agent Memory</h1>

<p align="center">AI without memory is just a tool. AI with memory becomes an asset.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb"><img src="https://img.shields.io/badge/OpenClaw-Plugin-6C63FF?logo=npm&logoColor=white" alt="OpenClaw Plugin" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA043?logo=opensourceinitiative&logoColor=white" alt="MIT License" /></a>
</p>


**TencentDB Agent Memory is an Agent memory system built by the Tencent Cloud Database team**, adding persistent long-term memory to OpenClaw. Through a 4-layer progressive memory pyramid, it automatically handles memory capture, layered distillation, on-demand recall and injection — turning an Agent from "chat-only" into a long-term, cross-session AI assistant that continuously learns and understands its users.

## Benchmark

Evaluated on [PersonaMem](https://github.com/jiani-huang/PersonaMem) (UPenn, COLM 2025) — 589 questions, 20 actors.

| Category | OpenClaw Native Memory | TencentDB Agent Memory |
| :--- | :---: | :---: |
| Recall Update Reason | 70.97% | **88.89%** |
| Preference Evolution | 66.67% | **83.45%** |
| Personalized Recommendation | 46.67% | **76.36%** |
| Scenario Generalization | 31.58% | **78.95%** |
| Recall User Facts | 29.63% | **79.07%** |
| Recall Facts | 25.00% | **76.47%** |
| Creative Suggestion | 24.00% | **45.16%** |
| **Overall** | **47.85%** | **76.10%** |

## Highlights

- **OpenClaw native plugin** — package name `@tencentdb-agent-memory/memory-tencentdb`, one command to install
- **4-layer memory pipeline**: L0 Raw Dialogue → L1 Structured Memory → L2 Scenario Synthesis → L3 User Profile
- **Hybrid recall**: supports `keyword`, `embedding`, and `hybrid` strategies
- **Two retrieval tools**: `tdai_memory_search` (structured memory) and `tdai_conversation_search` (raw conversations)
- **Local-first storage**: JSONL + SQLite, data is directly inspectable on disk
- **Operational features**: deduplication, checkpoint, backup, scheduled cleanup, metrics logging
- **MIT License**

## Quick Start

### Requirements

- Node.js `>= 22.16.0`
- OpenClaw `>= 2026.3.13`

### Install

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

Once installed, the plugin hooks into the OpenClaw conversation lifecycle and automatically handles conversation capture, memory recall, and L1/L2/L3 processing.

### Development from Source

No build step required. Node.js 22.16+ natively supports TypeScript type stripping, and OpenClaw loads `.ts` source files directly.

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory
npm install
openclaw plugins install --link .
```

`install --link` registers the current directory as a local plugin in OpenClaw. Source changes take effect after restarting the Gateway.

### Optional: Enable Embedding Recall

To use vector retrieval or hybrid recall, add an embedding configuration. Currently supports remote embedding services compatible with the OpenAI API.

```jsonc
{
  "plugins": {
    "entries": {
      "memory-tencentdb": {
        "enabled": true,
        "config": {
          "embedding": { // Embedding model config (not LLM model)
            "enabled": true, // Enable vector search
            "provider": "openai", // Only OpenAI-compatible API is supported
            "baseUrl": "https://xxx", // API Base URL
            "apiKey": "xxx", // API Key
            "model": "text-embedding-3-large", // Model name
            "dimensions": 1024 // Vector dimensions (must match the chosen model)
          }
        }
      }
    }
  }
}
```


## Architecture

```text
        ┌─────────────────┐
        │   L3 Profile    │  Preferences & behavioral patterns
        ├─────────────────┤
        │  L2 Scenarios   │  Cross-session task / scenario blocks
        ├─────────────────┤
        │  L1 Structured  │  Facts, constraints, preferences, decisions
        ├─────────────────┤
        │  L0 Dialogue    │  Complete conversation records
        └─────────────────┘
```

Each layer serves a different purpose:

- **L0** preserves raw conversations for replay and precise retrieval
- **L1** extracts high-value information for direct recall
- **L2** organizes scattered memories into scenario blocks across sessions
- **L3** maintains a user profile for long-term preference modeling

## Lifecycle

| Stage | Trigger | Action |
|---|---|---|
| Recall | `before_prompt_build` | Recall relevant memory and inject into context |
| L0 | `agent_end` | Write raw conversation logs |
| L1 | Scheduled | Extract structured memory, deduplicate, persist |
| L2 | After L1 | Update scenario blocks |
| L3 | Threshold reached | Generate or refresh user profile |
| Shutdown | `gateway_stop` | Clean up resources |

The plugin also registers two tools for the Agent to call directly:

- `tdai_memory_search`: queries L1 structured memory. Useful for questions like "what does the user prefer" or "what constraints were confirmed earlier".
- `tdai_conversation_search`: queries L0 raw conversations. Useful when exact original wording is needed.

## Retrieval

Three recall strategies:

| Strategy | Implementation |
|---|---|
| `keyword` | FTS5 full-text search with jieba for Chinese tokenization |
| `embedding` | sqlite-vec vector similarity search |
| `hybrid` | Merged keyword and vector results |

All backed by SQLite.

## Configuration

Grouped by capability:

| Config Group | Purpose |
|---|---|
| `capture` | L0 conversation capture, exclusion rules, retention |
| `extraction` | L1 extraction, deduplication, per-run limit |
| `persona` | L2/L3 trigger frequency, scenario limit, backup count |
| `pipeline` | L1/L2/L3 scheduling |
| `recall` | Auto-recall toggle, result count, threshold, strategy |
| `embedding` | Vector retrieval service configuration |
| `report` | Metrics logging |

Minimum configuration is just installing the plugin. Add `embedding` and scheduling parameters for better recall quality.

## Data Directory

```text
<pluginDataDir>/
├── conversations/   # L0 raw conversations
├── records/         # L1 structured memory
├── scene_blocks/    # L2 scenario blocks
├── .metadata/       # checkpoints, indexes, metadata
└── .backup/         # backups
```

## Scope

This repository is the core OpenClaw plugin implementation.

**Includes**: plugin entry and lifecycle hooks, 4-layer memory pipeline, retrieval tools and auto-recall, JSONL + SQLite local storage, checkpoint / backup / cleanup / logging.

### Code Structure

```text
TencentDB-Agent-Memory/
├── index.ts                  # Plugin registration, tool registration, lifecycle hooks
├── openclaw.plugin.json
├── package.json
├── CHANGELOG.md
└── src/
    ├── hooks/                # Auto-recall and auto-capture
    ├── conversation/         # L0 conversation management
    ├── record/               # L1 extraction and persistence
    ├── scene/                # L2 scenario synthesis
    ├── persona/              # L3 user profile
    ├── store/                # SQLite / FTS / vector retrieval
    ├── tools/                # Retrieval tool registration
    ├── prompts/              # Prompt templates
    ├── report/               # Metrics reporting
    └── utils/
```

## License

MIT. See [LICENSE](LICENSE).
