import type { Api, Model } from "@earendil-works/pi-ai";
import {
  PI_DELEGATION_TIERS,
  loadDelegationConfig,
  saveDelegationConfig,
  type DelegationConfig,
} from "../../../shared/subagent-models.ts";
import {
  loadNestingConfig,
  parseDepthArgument,
  saveNestingConfig,
  type NestingConfig,
} from "../nesting-config.ts";
import {
  loadSummaryConfig,
  saveSummaryConfig,
  type SummaryConfig,
} from "../summary-config.ts";
import {
  applyTierSelection,
  pickTierConfig,
  tierTargetLabel,
  type TierPickerUi,
} from "./model-picker.ts";

export interface SubagentsMenuUi extends TierPickerUi {
  input(title: string, placeholder: string): Promise<string | undefined>;
}

export interface SubagentsSettingsStore {
  loadDelegation(): DelegationConfig;
  saveDelegation(value: DelegationConfig): Promise<void>;
  loadNesting(): NestingConfig;
  saveNesting(value: NestingConfig): Promise<void>;
  loadSummary(): SummaryConfig;
  saveSummary(value: SummaryConfig): Promise<void>;
}

const defaultStore: SubagentsSettingsStore = {
  loadDelegation: loadDelegationConfig,
  saveDelegation: saveDelegationConfig,
  loadNesting: loadNestingConfig,
  saveNesting: saveNestingConfig,
  loadSummary: loadSummaryConfig,
  saveSummary: saveSummaryConfig,
};

const summaryNumbers = [
  { key: "inputCharCap", label: "Summary input cap", unit: "chars", min: 1 },
  { key: "rawCharCap", label: "Raw report cap", unit: "chars", min: 1 },
  {
    key: "skipUnderChars",
    label: "Summary skip threshold",
    unit: "chars",
    min: 0,
  },
  { key: "timeoutMs", label: "Summary timeout", unit: "ms", min: 1 },
] as const;

interface MenuItem {
  label: string;
  edit(): Promise<string | undefined>;
}

interface SubagentsMenuDeps {
  ui: SubagentsMenuUi;
  cwd: string;
  models: readonly Model<Api>[];
  store?: SubagentsSettingsStore;
  effectiveCeiling?: () => number | null;
}

function ceilingLabel(value: number | null): string {
  return value === null ? "off" : `$${value}/Mtok output`;
}

export async function runSubagentsMenu(deps: SubagentsMenuDeps): Promise<void> {
  const { ui, cwd, models } = deps;
  const store = deps.store ?? defaultStore;
  while (true) {
    const config = store.loadDelegation();
    const nesting = store.loadNesting();
    const summary = store.loadSummary();
    const ceiling = deps.effectiveCeiling
      ? deps.effectiveCeiling()
      : config.costCeiling;
    // The claude tier is not offered; only tiers the pi runtime exposes.
    const items: MenuItem[] = PI_DELEGATION_TIERS.map((tier) => ({
      label: `${tier} · ${tierTargetLabel(config, tier)}`,
      async edit() {
        const result = await pickTierConfig({
          ui,
          config,
          cwd,
          models,
          ceiling,
          tier,
        });
        if (!result) return undefined;
        const next = applyTierSelection(
          store.loadDelegation(),
          tier,
          result.config.tiers[tier],
        );
        await store.saveDelegation(next);
        return `${tier} → ${tierTargetLabel(next, tier)}`;
      },
    }));
    items.push(
      {
        label: `Cost ceiling · ${ceilingLabel(config.costCeiling)}${ceiling !== config.costCeiling ? ` · effective ${ceilingLabel(ceiling)} (launch override)` : ""}`,
        async edit() {
          const raw = await ui.input(
            "Subagent cost ceiling ($/Mtok output, off to disable)",
            ceilingLabel(config.costCeiling),
          );
          if (raw === undefined || !raw.trim()) return undefined;
          const text = raw.trim().replace(/^\$/, "").toLowerCase();
          const value = text === "off" ? null : Number(text);
          if (value !== null && (!Number.isFinite(value) || value <= 0))
            throw new Error('Enter a positive dollar amount or "off".');
          await store.saveDelegation({
            ...store.loadDelegation(),
            costCeiling: value,
          });
          return `Subagent cost ceiling: ${ceilingLabel(value)}`;
        },
      },
      {
        label: `Maximum depth · ${nesting.maxDepth} (new root managers only)`,
        async edit() {
          const raw = await ui.input(
            "Maximum depth (main is 0; children are 1)",
            String(nesting.maxDepth),
          );
          if (raw === undefined || !raw.trim()) return undefined;
          const value = parseDepthArgument(raw);
          await store.saveNesting({ maxDepth: value });
          return `Saved maximum depth ${value}. Changes affect new root managers only.`;
        },
      },
      {
        label: `Report summaries · ${summary.enabled ? "on" : "off"}`,
        async edit() {
          const choice = await ui.select("Report summaries", ["on", "off"]);
          if (choice !== "on" && choice !== "off") return undefined;
          await store.saveSummary({
            ...store.loadSummary(),
            enabled: choice === "on",
          });
          return `Report summaries: ${choice}`;
        },
      },
    );
    for (const spec of summaryNumbers) {
      items.push({
        label: `${spec.label} · ${summary[spec.key]} ${spec.unit}`,
        async edit() {
          const raw = await ui.input(
            `${spec.label} (${spec.unit}, minimum ${spec.min})`,
            String(summary[spec.key]),
          );
          if (raw === undefined || !raw.trim()) return undefined;
          const text = raw.trim();
          const value = Number(text);
          if (
            !/^[0-9]+$/.test(text) ||
            !Number.isSafeInteger(value) ||
            value < spec.min
          )
            throw new Error(
              `${spec.label} must be a ${spec.min === 0 ? "non-negative" : "positive"} safe integer.`,
            );
          await store.saveSummary({
            ...store.loadSummary(),
            [spec.key]: value,
          });
          return `${spec.label}: ${value} ${spec.unit}`;
        },
      });
    }
    const labels = items.map((item) => item.label);
    const choice = await ui.select("Subagents settings · Esc to close", labels);
    if (choice === undefined) return;
    const item = items[labels.indexOf(choice)];
    if (!item) return;
    try {
      const message = await item.edit();
      if (message) ui.notify(message, "info");
    } catch (error) {
      ui.notify(
        `Subagent settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }
}
