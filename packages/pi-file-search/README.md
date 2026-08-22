# @tylerho/pi-file-search

Adds native fd and rg tools for fast, gitignore-aware file search with automatic binary resolution.

## Install

`pi install npm:@tylerho/pi-file-search`

---

# File-search

First-class `fd` and `rg` tools for pi. The extension registers `fd` (find files by name) and `rg` (search file contents) as native agent tools with typed parameters, standard pi output truncation (2000 lines / 50KB) with full output spilled to a temp file, and TUI call/result rendering. It exists so the agent gets fast, gitignore-aware file search without shelling out to `find`/`grep` ad hoc — and so the tools work on any machine: on session start each tool resolves a usable binary, downloading an official release into `~/.pi/agent/bin/` only if no system binary (or prior download) exists.

## Key concepts

- **Binary resolution per tool, three tiers.** `resolveBinary` tries, in order: (1) a system binary on PATH — `fd`/`fdfind` (Debian/Ubuntu ship `fdfind`), `rg` — used silently; (2) an existing fallback at `~/.pi/agent/bin/<tool>` (repo `bin/` dir, resolved from the module's location) — used silently; (3) a fresh download of a pinned official GitHub release into `bin/` — the *only* case that surfaces a UI notification (`installNotifications`). Resolution runs inside `Effect.cached` so it happens once per session and is awaited by both tools.
- **Downloads are defensive.** HTTPS-only, `content-length` and streaming caps (25 MB), ≤10 redirects, SHA-256 verified against hardcoded digests, staged atomic write (copy to `.<pid>.<uuid>.tmp`, `chmod 0o755`, rename). Versions pinned: fd 10.4.2 (10.3.0 on Intel macOS — 10.4.2 dropped Intel archives), rg 15.2.0; Linux uses statically-linked musl builds. Unsupported platforms (e.g. `s390x`) fail with `UnsupportedPlatformError` telling the user to install the tool manually.
- **Pure, testable argv construction.** `buildFdArgs`/`buildRgArgs` are synchronous and side-effect free so exact argv can be asserted in tests. The pattern is always placed after a `--` separator so user-controlled input can never be parsed as a flag. `path` is normalized: leading `@` stripped (some models prefix paths with it), `~`/`~/…` expanded. All numeric params are clamped to hard limits.
- **Bounded-memory output pipeline.** `executeSearchProcess` spawns the binary (cwd = `ctx.cwd`) and streams stdout *both* to a temp spill file and through a preview state that counts lines/bytes and truncates the in-memory preview at pi's standard `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`. If truncated, the temp dir is retained and the result carries `fullOutputPath` plus a `[Output truncated: … Full output saved to: …]` notice; if not, the dir is removed via `Effect.ensuring`. Stderr is capped at 64 KB. Tool errors call `discardCapturedOutput` to clean up the spill dir.
- **Exit classification.** rg exits 1 with zero output lines = "no matches" (a normal result, rendered "No matches found"); fd exits 0 even with no results (its `--max-results` output may simply be empty). Any other nonzero exit → `SearchError` (`<tool> failed: <stderr>`). A 60 s `EXEC_TIMEOUT_MS` timeout yields `<tool> timed out.`; an aborted signal (tool-call cancel) yields `<tool> search was cancelled.`
- **Limits & defaults.** fd: `limit` default 1000, max 10 000, `max_depth` 1–64. rg: `limit` (per-file `--max-count`) default 100, max 1000; `context` 0–20; case handling `--case-sensitive` / `--ignore-case` / `--smart-case` for true / false / omitted.
- **Rendering.** Each tool has `renderCall`/`renderResult` for the TUI: a compact flag summary while calling, result line showing match count ("N entries" / "N output lines") + "(truncated)" warning; the expanded view dims the first 20 content lines and appends `Full output: <path>`.

## API

### Tools (registered by the parent LLM)

#### `fd` — "Find Files"

TypeBox schema (all params optional): `pattern` (string, regex unless `glob`; omitted = everything under `path`), `path` (string, default cwd), `type` (`"file" | "directory" | "symlink"`), `extension` (string, e.g. `"ts"`, leading dots stripped), `glob` (boolean), `hidden` (boolean), `max_depth` (integer 1–64), `limit` (integer 1–10 000, default 1000).

Return `AgentToolResult<FdToolDetails>`: `content: [{ type: "text", text }]` — `"No files found"` when empty, else formatted output; `details: { binarySource: "system" | "bundled" | "installed", matchCount: number, truncated: boolean, fullOutputPath?: string }`.

```
fd { pattern: "parse.ts", path: "src", max_depth: 3 }
fd { glob: true, pattern: "*.test.ts", extension: "ts", hidden: true }
```

#### `rg` — "Search Content"

TypeBox schema: `pattern` (string, **required**), `path` (string, default cwd), `glob` (string, e.g. `"*.ts"`), `file_type` (string, ripgrep type, e.g. `"ts"`), `case_sensitive` (boolean — `true` forces sensitive, `false` forces insensitive, omitted = smart-case), `fixed_strings` (boolean — literal search, for patterns with regex metacharacters), `hidden` (boolean), `context` (integer 0–20), `limit` (integer 1–1000, per-file max count, default 100).

Return `AgentToolResult<RgToolDetails>`: `content: [{ type: "text", text }]` — `"No matches found"` when empty, else `--line-number` output; `details: { binarySource, outputLines: number, truncated: boolean, fullOutputPath?: string }`.

```
rg { pattern: "TODO", path: "src", file_type: "ts", context: 2 }
rg { pattern: "as any", fixed_strings: true, case_sensitive: true }
```

### Events

- `pi.on("session_start", …)` — resolves both binaries concurrently (`Effect.all`, unbounded concurrency) and, when `ctx.hasUI`, notifies once per process (`notified` flag): an `"info"` notification per freshly downloaded tool, an `"error"` notification per failed tool setup (`file-search <tool> setup failed: …`), or one `"error"` for a resolution-phase failure. This is what surfaces the "downloaded fd 10.4.2 to …" notice.

### Commands / shortcuts

None — the extension registers tools only. No `registerCommand`, no `registerShortcut`, no config files.

### Exported module API (for tests and reuse)

- `index.ts`: `makeBinaryInitializers(binDir, target, env)` → `{ fd, rg }` of cached `Effect<ResolvedBinary>` (lets one failing tool not disable the other); `installNotifications(binaries)` → human-readable notices for `"installed"`-source binaries only; types `FdToolDetails`, `RgToolDetails`; default export `fileSearchTools(pi: ExtensionAPI)`.
- `src/args.ts`: constants `FD_DEFAULT_LIMIT` (1000), `FD_MAX_LIMIT` (10 000), `FD_MAX_DEPTH_LIMIT` (64), `RG_DEFAULT_COUNT_LIMIT` (100), `RG_MAX_COUNT_LIMIT` (1000), `RG_MAX_CONTEXT` (20); `normalizeSearchPath(raw)` (strips `@`, expands `~`); types `FdEntryType`, `FdToolParams`, `RgToolParams`; `buildFdArgs(params)`, `buildRgArgs(params)`.
- `src/binaries.ts`: `FD_VERSION` ("10.4.2"), `FD_INTEL_DARWIN_VERSION` ("10.3.0"), `RG_VERSION` ("15.2.0"); types `ToolName`, `BinarySource` (`"system" | "bundled" | "installed"`), `ToolSpec`, `PlatformTarget`, `ReleaseAsset`, `BinaryEnv` (injectable `probe`/`install`), `ResolvedBinary`; `TOOL_SPECS`; `releaseAsset(tool, target)`; `currentTarget()`; `repositoryBinDir()` (`~/.pi/agent/bin`); errors `UnsupportedPlatformError`, `InstallError` (both `Data.TaggedError`); `resolveBinary(spec, binDir, target, env)`; `readBoundedResponse(response, maxBytes?)`; `liveBinaryEnv` (real `probe` via `--version`/`--max-results`, `install` via HTTPS + tar).
- `src/output.ts`: types `FormattedOutput`, `CapturedOutput`, `FormatOutputOptions`; `formatCapturedOutput(captured)` (for already-streamed output); `formatOutput(output, options)` (async, with injectable `persistFullOutput` for tests).
- `src/process.ts`: `executeSearchProcess({ command, args, cwd, tempPrefix })` → `Effect<{ code, stderr, output: CapturedOutput }>`; `discardCapturedOutput(output)`.
- `src/prompt.ts`: model-facing text constants — `FD_TOOL_DESCRIPTION`, `FD_PROMPT_SNIPPET`, `FD_PROMPT_GUIDELINES`, `FD_PARAMETER_DESCRIPTIONS`, `RG_TOOL_DESCRIPTION`, `RG_PROMPT_SNIPPET`, `RG_PROMPT_GUIDELINES`, `RG_PARAMETER_DESCRIPTIONS`.

## Examples

1. **Discover files by name/extension** — the agent wants all test files under `src`:
   `fd { glob: true, pattern: "*.test.ts", path: "src", max_depth: 3 }` → returns matching paths; `details.matchCount` reports how many; empty result returns content `"No files found"`.
2. **Content search with context** — find TODOs in TypeScript with surrounding lines:
   `rg { pattern: "TODO", path: "src", file_type: "ts", context: 2 }` → `--line-number` matches with 2 lines of context; `details.outputLines` counts output lines.
3. **Literal search of a regex-y snippet** — per the tool guidelines, `fixed_strings` avoids regex interpretation:
   `rg { pattern: "as any", fixed_strings: true }` → literal match (equivalent of `rg -F`).
4. **List everything in a directory** — `fd { path: "~/.pi/agent/extensions" }` (pattern omitted, `~` expanded) → the equivalent of `fd . <path>`, capped at 1000 entries by default.
5. **Huge result spill** — a search producing >2000 lines returns a truncated preview plus `details.fullOutputPath`; the agent can `read` that temp file for the complete output.
