import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SerializationOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
}

export const MAX_CALL_KEY_INPUT_BYTES = 512 * 1024;
const LOSSLESS_MAX_DEPTH = 64;
const LOSSLESS_MAX_NODES = 50_000;

/** Serialize JSON data without normalizing or truncating any value. */
export function losslessJsonStringify(
  value: unknown,
  maxBytes = MAX_CALL_KEY_INPUT_BYTES,
): string {
  const output: string[] = [];
  const active = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  const append = (part: string) => {
    bytes += byteLength(part);
    if (bytes > maxBytes)
      throw new Error(`JSON value exceeds the ${maxBytes} byte limit`);
    output.push(part);
  };

  const encode = (current: unknown, depth: number): void => {
    if (++nodes > LOSSLESS_MAX_NODES || depth > LOSSLESS_MAX_DEPTH)
      throw new Error("JSON value exceeds the lossless serialization limits");
    if (current === null) {
      append("null");
      return;
    }
    if (typeof current === "boolean") {
      append(current ? "true" : "false");
      return;
    }
    if (typeof current === "string") {
      if (byteLength(current) > maxBytes)
        throw new Error(`JSON string exceeds the ${maxBytes} byte limit`);
      append(JSON.stringify(current));
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new Error("JSON number must be finite");
      append(Object.is(current, -0) ? "-0" : String(current));
      return;
    }
    if (typeof current !== "object")
      throw new Error(`Value of type ${typeof current} is not JSON data`);
    if (active.has(current)) throw new Error("JSON value contains a cycle");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getOwnPropertySymbols(current).length > 0)
          throw new Error("JSON array has symbol properties");
        const names = Object.getOwnPropertyNames(current).filter(
          (name) => name !== "length",
        );
        if (names.length !== current.length)
          throw new Error("JSON array has holes or extra properties");
        append("[");
        for (let index = 0; index < current.length; index++) {
          if (index > 0) append(",");
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (!descriptor?.enumerable || !("value" in descriptor))
            throw new Error("JSON array contains a non-data property");
          encode(descriptor.value, depth + 1);
        }
        append("]");
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("JSON object must have a plain prototype");
      if (Object.getOwnPropertySymbols(current).length > 0)
        throw new Error("JSON object has symbol properties");
      const names = Object.getOwnPropertyNames(current).sort();
      append("{");
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!;
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (!descriptor?.enumerable || !("value" in descriptor))
          throw new Error("JSON object contains a non-data property");
        if (index > 0) append(",");
        if (byteLength(name) > maxBytes)
          throw new Error(`JSON key exceeds the ${maxBytes} byte limit`);
        append(JSON.stringify(name));
        append(":");
        encode(descriptor.value, depth + 1);
      }
      append("}");
    } finally {
      active.delete(current);
    }
  };

  encode(value, 0);
  return output.join("");
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort())
    result[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
  return result;
}

/** Versioned key over the complete call input and the preceding call key. */
export function callKey(
  prompt: string,
  options: unknown,
  previousKey?: string,
): string {
  try {
    const canonical = losslessJsonStringify(
      { version: 2, prompt, options, previousKey: previousKey ?? null },
      MAX_CALL_KEY_INPUT_BYTES,
    );
    return `v2:${createHash("sha256").update(canonical).digest("hex")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/byte limit/.test(message))
      throw new Error(
        `Workflow call input exceeds the ${MAX_CALL_KEY_INPUT_BYTES} byte limit`,
      );
    throw new Error(`Workflow call input is not lossless JSON: ${message}`);
  }
}

/** Candidate key for old unversioned records; undefined means unverifiable. */
export function legacyCallKey(
  prompt: string,
  options: unknown,
): string | undefined {
  try {
    losslessJsonStringify({ prompt, options }, MAX_CALL_KEY_INPUT_BYTES);
    const input = { prompt, options: sortJsonKeys(options) };
    losslessJsonStringify(input, MAX_CALL_KEY_INPUT_BYTES);
    const legacy = JSON.stringify(toSerializable(input));
    if (typeof legacy !== "string") return undefined;
    if (
      losslessJsonStringify(JSON.parse(legacy), MAX_CALL_KEY_INPUT_BYTES) !==
      losslessJsonStringify(input, MAX_CALL_KEY_INPUT_BYTES)
    ) {
      return undefined;
    }
    return createHash("sha256").update(legacy).digest("hex").slice(0, 32);
  } catch {
    return undefined;
  }
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Normalize arbitrary values to inert JSON data. Cycles, bigint, non-finite
 * numbers, deep trees, throwing properties, and very large strings are all
 * represented explicitly instead of making artifact persistence fail.
 */
export function toSerializable(
  value: unknown,
  options: SerializationOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  const seen = new WeakMap<object, string>();
  let nodes = 0;

  const visit = (
    current: unknown,
    depth: number,
    location: string,
  ): unknown => {
    nodes++;
    if (nodes > maxNodes) return "[truncated: node limit]";
    if (depth > maxDepth) return "[truncated: depth limit]";
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (byteLength(current) <= maxStringBytes) return current;
      return `${truncateUtf8(current, maxStringBytes)}\n[truncated: string limit]`;
    }
    if (typeof current === "number") {
      return Number.isFinite(current)
        ? current
        : `[number: ${String(current)}]`;
    }
    if (typeof current === "bigint") return `${current.toString()}n`;
    if (typeof current === "undefined") return "[undefined]";
    if (typeof current === "symbol")
      return `[symbol: ${current.description ?? ""}]`;
    if (typeof current === "function")
      return `[function: ${current.name || "anonymous"}]`;
    if (typeof current !== "object") return String(current);

    const prior = seen.get(current);
    if (prior) return `[circular: ${prior}]`;
    seen.set(current, location);

    if (Array.isArray(current)) {
      return current.map((item, index) =>
        visit(item, depth + 1, `${location}[${index}]`),
      );
    }

    if (current instanceof Date) {
      return Number.isNaN(current.getTime())
        ? "[date: invalid]"
        : current.toISOString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        ...(current.stack
          ? { stack: truncateUtf8(current.stack, 16 * 1024) }
          : {}),
      };
    }

    const result: Record<string, unknown> = Object.create(null);
    let keys: string[];
    try {
      keys = Object.keys(current);
    } catch (error) {
      return `[unreadable object: ${error instanceof Error ? error.message : String(error)}]`;
    }
    for (const key of keys) {
      try {
        result[key] = visit(
          (current as Record<string, unknown>)[key],
          depth + 1,
          `${location}.${key}`,
        );
      } catch (error) {
        result[key] =
          `[unreadable property: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    return result;
  };

  return visit(value, 0, "$root");
}

/** Serialize to valid JSON no larger than the requested cap. */
export function safeStringify(
  value: unknown,
  options: SerializationOptions = {},
) {
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const normalized = toSerializable(value, options);
  const serialized = JSON.stringify(normalized, null, 2) ?? "null";
  if (byteLength(serialized) <= maxBytes) return serialized;

  let previewBytes = Math.max(32, Math.floor(maxBytes / 3));
  while (previewBytes > 0) {
    const fallback = JSON.stringify(
      {
        truncated: true,
        reason: `serialized value exceeded ${maxBytes} bytes`,
        preview: truncateUtf8(serialized, previewBytes),
      },
      null,
      2,
    );
    if (byteLength(fallback) <= maxBytes) return fallback;
    previewBytes = Math.floor(previewBytes / 2);
  }
  return JSON.stringify({ truncated: true });
}

/** Durable same-directory replace: readers see either the old or new file. */
export function writeFileAtomic(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The original write error is more useful.
    }
    throw error;
  }
}
