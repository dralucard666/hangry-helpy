import type { Question, State } from "./types.ts";

export const SYSTEM_PROMPT =
  "You are a System One decision model. You read the STATE, then answer the QUESTION by " +
  "outputting exactly one option label and nothing else. Never explain, never add words.";

const CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SCORE_LABELS = "0123456789".split("");
const NOUL_LABELS = ["yes", "no"] as const;

/** Render arbitrary JSON-ish state as a compact outline (small models read this better than raw JSON). */
export function renderState(state: State): string {
  const lines: string[] = [];
  const walk = (value: unknown, indent: string, key?: string) => {
    const prefix = key === undefined ? indent : `${indent}${humanise(key)}: `;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v !== "object" || v === null)) {
        lines.push(`${prefix}${value.map(String).join(", ")}`);
      } else {
        lines.push(`${prefix}`.trimEnd());
        for (const item of value) walk(item, indent + "  ", "-");
      }
      return;
    }
    if (typeof value === "object") {
      if (key !== undefined) lines.push(`${indent}${humanise(key)}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, key === undefined ? indent : indent + "  ", k);
      return;
    }
    lines.push(`${prefix}${String(value)}`);
  };
  walk(state, "");
  return lines.join("\n");
}

function humanise(key: string): string {
  if (key === "-") return "-";
  return key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export interface RenderedQuestion {
  /** Text appended after the state inside the user turn. */
  text: string;
  /** The label strings whose next-token logits are read, in option order. */
  labels: string[];
}

export function renderQuestion(q: Question): RenderedQuestion {
  switch (q.type) {
    case "noul":
      return {
        text: `QUESTION: ${q.instructions}\nAnswer with exactly one word: yes or no.`,
        labels: [...NOUL_LABELS],
      };
    case "choice": {
      const ids = Object.keys(q.criteria);
      if (ids.length < 2 || ids.length > CHOICE_LABELS.length) {
        throw new Error(`choice questions need 2..${CHOICE_LABELS.length} options, got ${ids.length}`);
      }
      const options = ids.map((id, i) => {
        const desc = q.criteria[id];
        return `${CHOICE_LABELS[i]}: ${desc ? `${id} — ${desc}` : id}`;
      });
      return {
        text: `QUESTION: ${q.instructions}\nOPTIONS:\n${options.join("\n")}\nAnswer with exactly one letter.`,
        labels: CHOICE_LABELS.slice(0, ids.length),
      };
    }
    case "score": {
      if (q.criteria.length < 2 || q.criteria.length > SCORE_LABELS.length) {
        throw new Error(`score questions need 2..${SCORE_LABELS.length} anchors, got ${q.criteria.length}`);
      }
      const anchors = q.criteria.map((c, i) => `${i}: ${c}`);
      return {
        text: `QUESTION: ${q.instructions}\nSCALE (low to high):\n${anchors.join("\n")}\nAnswer with exactly one digit.`,
        labels: SCORE_LABELS.slice(0, q.criteria.length),
      };
    }
  }
}

/**
 * Qwen3 ChatML layout. The assistant turn is pre-filled with an empty <think> block, which is exactly
 * what Qwen3's own chat template emits in non-thinking mode, so the very next token is the answer.
 */
export function buildPrompt(stateText: string, questionText: string): { prefix: string; suffix: string } {
  const prefix = `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\nSTATE:\n${stateText}\n\n`;
  const suffix = `${questionText}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  return { prefix, suffix };
}
