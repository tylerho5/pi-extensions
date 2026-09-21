import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  stripFrontmatter,
  type ExtensionAPI,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
  expandSkillTokens,
  MAX_STACKED_SKILLS,
  tidySkillBlocks,
  unescapeSkillTokens,
  type ExpandResult,
} from "./expand.ts";

interface CachedBody {
  mtimeMs: number;
  body: string;
}

export default function (pi: ExtensionAPI) {
  const bodies = new Map<string, CachedBody>();

  function readBody(filePath: string): string | undefined {
    try {
      const target = statSync(filePath).isDirectory()
        ? join(filePath, "SKILL.md")
        : filePath;
      const { mtimeMs } = statSync(target);
      const cached = bodies.get(target);
      if (cached && cached.mtimeMs === mtimeMs) return cached.body;

      const body = stripFrontmatter(readFileSync(target, "utf-8")).trim();
      bodies.set(target, { mtimeMs, body });
      return body;
    } catch {
      return undefined;
    }
  }

  pi.on("input", (event, ctx) => {
    if (!event.text.includes("/")) return;

    let commands: SlashCommandInfo[];
    try {
      commands = pi.getCommands();
    } catch {
      return;
    }

    const skills = new Map<string, SlashCommandInfo>();
    const reserved = new Set<string>();
    for (const command of commands) {
      if (command.source === "skill") {
        skills.set(command.name.slice("skill:".length), command);
      } else {
        reserved.add(command.name);
      }
    }
    if (skills.size === 0) return;

    const result = expandSkillTokens(event.text, {
      max: MAX_STACKED_SKILLS,
      // Explicit /skill:name is unambiguous, so only bare names defer to
      // commands and templates that already own them.
      resolve: (name, explicit) =>
        skills.has(name) && (explicit || !reserved.has(name)),
      render: (name) => {
        const skill = skills.get(name)!;
        const body = readBody(skill.sourceInfo.path);
        if (body === undefined) return undefined;
        const baseDir =
          skill.sourceInfo.baseDir ?? dirname(skill.sourceInfo.path);
        return `<skill name="${name}" location="${skill.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
      },
    });

    const text = unescapeSkillTokens(
      result.text,
      // Escapes only matter for names that pi treats as commands or skills.
      (name) => skills.has(name) || reserved.has(name),
    );
    if (text === event.text) return;

    const notes = notices(result);
    if (notes) {
      ctx.ui.notify(
        `skill-stack: ${notes}`,
        result.overflow.length > 0 ? "warning" : "info",
      );
    }

    return { action: "transform", text };
  });

  // The API landed after the pinned 0.82 types, so cast: no-op on builds
  // without it, and the tidy-up is cosmetic either way.
  const host = pi as unknown as {
    registerMarkdownTransformer?: (
      transformer: (
        markdown: string,
        context: { messageType: string },
      ) => string,
    ) => void;
  };
  host.registerMarkdownTransformer?.((markdown, context) =>
    tidySkillBlocks(markdown, context),
  );
}

function notices(result: ExpandResult): string | undefined {
  const parts: string[] = [];
  if (result.overflow.length > 0) {
    parts.push(
      `left ${result.overflow.map((name) => `/${name}`).join(", ")} unexpanded (max ${MAX_STACKED_SKILLS} skills per prompt)`,
    );
  }
  if (result.duplicates.length > 0) {
    parts.push(
      `dropped repeated ${result.duplicates.map((name) => `/${name}`).join(", ")}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}
