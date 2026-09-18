# @tylerho/pi-file-search

Adds native fd and rg tools for fast, gitignore-aware file search with automatic binary resolution.

## Install

`pi install npm:@tylerho/pi-file-search`

---

# File-search

The extension registers `fd` and `rg` as pi tools. `fd` finds files and directories by name, `rg` searches file contents, and both drive a real fd or ripgrep binary that respects `.gitignore` by default. The tools exist so the agent searches with a typed call instead of shelling out to `find` or `grep` through bash.

## How it works

Each tool resolves a usable binary on session start and keeps it for the rest of the session. Resolution runs once per tool through `Effect.cached`, so the session-start handler and a later tool call share one resolution instead of probing twice. One failing tool does not disable the other. The tiers, in order:

- A system binary on `PATH`. `fd` probes `fd` and then `fdfind`, because Debian and Ubuntu install the binary under the second name. `rg` probes `rg`. A probe runs the command once from the temp directory with a 5 second timeout.
- An existing binary at `~/.pi/agent/bin/<tool>`. The path comes from the module location through `repositoryBinDir()`, not from the process working directory.
- A download of a pinned official release into `~/.pi/agent/bin/`. This is the only tier that shows a notification.

A download accepts HTTPS only, caps the archive at 25 MB through both the `content-length` header and a running byte count, and follows at most 10 redirects with the HTTP client in manual mode. The bytes must match a SHA-256 digest hardcoded in `src/binaries.ts`. The extension extracts the archive with `tar -xzf`, copies the binary to `<destination>.<pid>.<uuid>.tmp`, sets mode `0755`, and renames the staged file into place. A finalizer removes the staged file if the install fails partway. fd is pinned to 10.4.2 and rg to 15.2.0. Intel macOS keeps fd 10.3.0, because 10.4.2 dropped the `x86_64-apple-darwin` archive. Linux uses the statically linked musl builds. A platform with no asset fails with `UnsupportedPlatformError`, whose message tells the user to install the tool by hand and restart pi. A binary that installs but does not run fails with `InstallError`.

The `session_start` handler resolves both binaries with unbounded concurrency and reports the outcome once per process, guarded by a `notified` flag and by `ctx.hasUI`. A binary from the download tier produces one info notification naming the tool, its version, and the bin directory. A failed tool produces an error notification reading `file-search <tool> setup failed: <message>`. A failure in the resolution phase itself produces `file-search setup failed: <message>`.

Argument construction is synchronous and free of side effects, so tests assert the exact argv. Both builders put the pattern after a `--` separator, which keeps model-supplied text from being read as a flag. The path goes last and passes through `normalizeSearchPath`, which trims the value, strips one leading `@` (some models prefix paths with it), and expands `~` and `~/...` to the home directory. An empty path is dropped. Numeric parameters clamp to their bounds.

`buildFdArgs` emits `--color=never`, then `--hidden`, `--glob`, `--type` with the letter `f`, `d`, or `l`, `--extension` with leading dots stripped, `--max-depth`, and `--max-results`. The result cap is always present and defaults to 1000. After the `--` separator comes the pattern, or an empty string when `pattern` is omitted, which fd treats as a match for everything.

`buildRgArgs` emits `--line-number --color=never --no-heading --with-filename`, then one of `--case-sensitive`, `--ignore-case`, or `--smart-case` (the default when `case_sensitive` is absent), then `--fixed-strings`, `--hidden`, `--context`, `--glob`, `--type`, and `--max-count`. The per-file cap is always present and defaults to 100. The pattern follows the `--` separator.

`executeSearchProcess` spawns the binary with the session cwd, stdin ignored, and both output streams piped. It sends stdout to two places at once. The complete output goes to `output.txt` in a fresh temp directory, and a preview accumulates in memory with a running line and byte count. The preview stops growing once it passes the pi limits `DEFAULT_MAX_LINES` (2000) or `DEFAULT_MAX_BYTES` (50 KB), and trailing newlines count toward neither total. When the preview was cut, the temp directory stays and the result carries its path in `fullOutputPath`, with a notice appended to the text: `[Output truncated: <shown> of <total> lines (<shown size> of <total size>). Full output saved to: <path>]`. When nothing was cut, an `Effect.ensuring` finalizer deletes the directory. stderr is capped at 64 KB. A failed call deletes the spill directory through `discardCapturedOutput`.

Exit codes decide the outcome. ripgrep exits 1 when it finds nothing, so exit 1 with zero output lines is a normal empty result. fd exits 0 even with no matches, so zero output lines is the same empty result. Any other nonzero exit throws `SearchError` with `<tool> failed:` followed by the trimmed stderr or the exit code. A run that passes 60 seconds fails with `<tool> timed out.`, and a cancelled tool call reports `<tool> search was cancelled.` The cancellation signal comes from the tool call itself and reaches the Effect through `Effect.runPromiseExit`.

Both tools render through `renderCall` and `renderResult`. The call line shows the pattern in quotes, the path, and a compact flag summary. The result line reports the count (`N entries` for fd, `N output lines` for rg) and marks truncated output. The expanded view dims the first 20 lines of the result text, names the remaining line count, and appends the full output path when one exists.

## API

### Tools

`fd`, label "Find Files". All parameters are optional.

| Parameter | Type | Default | Behavior |
|---|---|---|---|
| `pattern` | string | none | Regex matched against file names, or a glob when `glob` is true. Omitted lists everything under `path`. |
| `path` | string | current working directory | Directory to search. |
| `type` | `"file"`, `"directory"`, or `"symlink"` | none | Restricts entries to one type. |
| `extension` | string | none | Keeps files with this extension, for example `ts` or `md`. Leading dots are stripped. |
| `glob` | boolean | false | Treats `pattern` as a glob, for example `*.test.ts`. |
| `hidden` | boolean | false | Includes hidden files and directories. |
| `max_depth` | integer, 1 to 64 | none | Maximum directory depth to descend. |
| `limit` | integer, 1 to 10000 | 1000 | Maximum number of results. |

`rg`, label "Search Content".

| Parameter | Type | Default | Behavior |
|---|---|---|---|
| `pattern` | string, required | none | Regex to search for, or literal text when `fixed_strings` is true. |
| `path` | string | current working directory | File or directory to search. |
| `glob` | string | none | Only search files matching this glob, for example `*.ts` or `src/**`. |
| `file_type` | string | none | Only search files of this ripgrep type, for example `ts`, `js`, `py`, or `rust`. |
| `case_sensitive` | boolean | smart case | `true` forces case-sensitive matching and `false` forces case-insensitive matching. |
| `fixed_strings` | boolean | false | Treats `pattern` as a literal string. |
| `hidden` | boolean | false | Searches hidden files and directories. |
| `context` | integer, 0 to 20 | none | Lines of context around each match. |
| `limit` | integer, 1 to 1000 | 100 | Maximum matches per file. |

Both tools return `AgentToolResult` with one text content entry. An empty result returns `No files found` for fd and `No matches found` for rg. The `details` object carries `binarySource` (`"system"`, `"bundled"`, or `"installed"`), the count, and `truncated`, plus `fullOutputPath` when a spill file exists. fd reports the count as `matchCount` and rg reports it as `outputLines`.

The model-facing text for both tools lives in `src/prompt.ts`. It supplies the tool descriptions, prompt snippets, prompt guidelines, and per-parameter descriptions from `FD_TOOL_DESCRIPTION`, `FD_PROMPT_SNIPPET`, `FD_PROMPT_GUIDELINES`, `FD_PARAMETER_DESCRIPTIONS`, `RG_TOOL_DESCRIPTION`, `RG_PROMPT_SNIPPET`, `RG_PROMPT_GUIDELINES`, and `RG_PARAMETER_DESCRIPTIONS`.

### Events

`session_start` resolves both binaries and emits the notifications described under How it works. There are no commands, no shortcuts, and no config files.

### Exported module API

- `index.ts`: default export `fileSearchTools(pi: ExtensionAPI)`, `makeBinaryInitializers(binDir, target, env)`, `installNotifications(binaries)`, and the types `FdToolDetails` and `RgToolDetails`.
- `src/args.ts`: `FD_DEFAULT_LIMIT` (1000), `FD_MAX_LIMIT` (10000), `FD_MAX_DEPTH_LIMIT` (64), `RG_DEFAULT_COUNT_LIMIT` (100), `RG_MAX_COUNT_LIMIT` (1000), `RG_MAX_CONTEXT` (20), `normalizeSearchPath(raw)`, `buildFdArgs(params)`, `buildRgArgs(params)`, and the types `FdEntryType`, `FdToolParams`, `RgToolParams`.
- `src/binaries.ts`: `FD_VERSION`, `FD_INTEL_DARWIN_VERSION`, `RG_VERSION`, `TOOL_SPECS`, `liveBinaryEnv`, `releaseAsset(tool, target)`, `currentTarget()`, `repositoryBinDir()`, `resolveBinary(spec, binDir, target, env)`, `readBoundedResponse(response, maxBytes?)`, the types `ToolName`, `BinarySource`, `ToolSpec`, `PlatformTarget`, `ReleaseAsset`, `BinaryEnv`, `ResolvedBinary`, and the errors `UnsupportedPlatformError` and `InstallError`.
- `src/output.ts`: `formatCapturedOutput(captured)`, `formatOutput(output, options)`, and the types `FormattedOutput`, `CapturedOutput`, `FormatOutputOptions`.
- `src/process.ts`: `executeSearchProcess({ command, args, cwd, tempPrefix })`, `discardCapturedOutput(output)`.

## Examples

1. Find test files under `src`: `fd { glob: true, pattern: "*.test.ts", path: "src", max_depth: 3 }`. The result lists matching paths and `details.matchCount` reports how many. With no matches the content reads `No files found`.
2. Search TypeScript for TODOs with two lines of context: `rg { pattern: "TODO", path: "src", file_type: "ts", context: 2 }`. The output uses `--line-number` and `details.outputLines` counts output lines.
3. Search for regex metacharacters as literal text: `rg { pattern: "as any", fixed_strings: true }` is the equivalent of `rg -F`.
4. List a directory: `fd { path: "~/.pi/agent/extensions" }` expands `~`, omits the pattern, and caps the listing at 1000 entries.
5. Spill a large result: a search over more than 2000 lines returns a truncated preview plus `details.fullOutputPath`, and the agent reads that temp file for the complete output.
