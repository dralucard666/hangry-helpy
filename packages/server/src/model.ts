/**
 * The decision model: a local "System One" readout in the style of Jev / OpenJev.
 *
 * We never let the LLM generate text. For each question we build a prompt that ends right where the
 * answer digit would go, run one forward pass, and read the logits of the tokens "0", "1", "2", …
 * A softmax over just those gives a probability per anchor; the answer is the probability-weighted
 * anchor index. Typed, fast, impossible to mis-parse.
 */
import path from "node:path";
import { getLlama, resolveModelFile, LlamaLogLevel, type LlamaContextSequence, type LlamaModel, type Token } from "node-llama-cpp";
import type { HealthResponse } from "@hangry/shared";

/** A question with ordered answer anchors, from lowest (index 0) to highest. */
export interface Question {
  text: string;
  anchors: readonly string[];
}

const MODELS_DIR = path.resolve(import.meta.dirname, "../../../models");
/** Small models put ~100% on one digit; dividing logits by this keeps the ordering but spreads probabilities. */
const TEMPERATURE = 2;
const SYSTEM =
  "You are a System One decision model. You read the STATE, then answer the QUESTION by " +
  "outputting exactly one option label and nothing else. Never explain, never add words.";

export class Model {
  status: HealthResponse["model"];
  private model!: LlamaModel;
  private sequence!: LlamaContextSequence;

  constructor(private uri: string) {
    this.status = { phase: "idle", name: uri };
  }

  /** Download (first run only), load onto the GPU, warm up. */
  async start(): Promise<void> {
    this.status = { phase: "downloading", name: this.uri, progress: 0 };
    const modelPath = await resolveModelFile(this.uri, {
      directory: MODELS_DIR,
      cli: false,
      onProgress: ({ totalSize, downloadedSize }) => (this.status.progress = downloadedSize / totalSize),
    });
    this.status = { phase: "loading", name: this.uri };
    const llama = await getLlama({ logLevel: LlamaLogLevel.error });
    this.model = await llama.loadModel({ modelPath });
    const context = await this.model.createContext({ contextSize: 1024 });
    this.sequence = context.getSequence();
    await this.ask("warm-up", { ok: { text: "Is this a warm-up?", anchors: ["no", "yes"] } });
    this.status = { phase: "ready", name: this.uri.replace(/^hf:/, "") };
    console.log(`model ready (${llama.gpu})`);
  }

  /**
   * Ask several questions about one piece of state. Returns, per question, a value in 0..1
   * (0 = first anchor, 1 = last anchor). All questions share the same prompt prefix, which the
   * sequence keeps in its cache, so only the question part is evaluated each time.
   * One call at a time: callers await each ask() before the next.
   */
  async ask(state: string, questions: Record<string, Question>): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const [key, q] of Object.entries(questions)) {
      const probs = await this.readout(this.prompt(state, q), q.anchors.length);
      result[key] = probs.reduce((sum, p, i) => sum + p * i, 0) / (q.anchors.length - 1);
    }
    return result;
  }

  /** Qwen3 chat format. The assistant turn is pre-filled with an empty think block so the next token is the digit. */
  private prompt(state: string, q: Question): string {
    const anchors = q.anchors.map((a, i) => `${i}: ${a}`).join("\n");
    return (
      `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
      `<|im_start|>user\nSTATE:\n${state}\n\n` +
      `QUESTION: ${q.text}\nSCALE (low to high):\n${anchors}\nAnswer with exactly one digit.<|im_end|>\n` +
      `<|im_start|>assistant\n<think>\n\n</think>\n\n`
    );
  }

  /** One forward pass; returns the softmax over the digit tokens 0..n-1. */
  private async readout(prompt: string, n: number): Promise<number[]> {
    const seq = this.sequence;
    const tokens = this.model.tokenize(prompt, true);
    const digits: Token[] = Array.from({ length: n }, (_, i) => this.model.tokenize(String(i))[0]!);

    await seq.adaptStateToTokens(tokens, false); // keep the matching prefix, drop the rest
    if (seq.nextTokenIndex >= tokens.length) await seq.eraseContextTokenRanges([{ start: tokens.length - 1, end: seq.nextTokenIndex }]);
    const pending = tokens.slice(seq.nextTokenIndex);
    const last = pending.pop()!;
    const out = await seq.controlledEvaluate([...pending, [last, { generateNext: { logits: { filter: { tokens: digits } } } }]]);
    const logits = out[pending.length]!.next.logits!;

    const max = Math.max(...digits.map((t) => logits.get(t) ?? -Infinity));
    const weights = digits.map((t) => Math.exp(((logits.get(t) ?? -1e9) - max) / TEMPERATURE));
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => w / sum);
  }
}
