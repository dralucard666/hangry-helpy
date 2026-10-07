import { getLlama, resolveModelFile, LlamaLogLevel, type Llama, type LlamaContext, type LlamaContextSequence, type LlamaModel, type Token } from "node-llama-cpp";
import type { ModelPhase } from "@hangry/shared";
import { buildPrompt, renderQuestion, renderState } from "./prompt.ts";
import type { Answers, ChoiceAnswer, NoulAnswer, Question, ScoreAnswer, SystemOneRequest, SystemOneResponse } from "./types.ts";

export interface EngineOptions {
  modelUri: string;
  modelsDir: string;
  sequences: number;
  contextSize: number;
  gpu: "auto" | "metal" | "cuda" | "vulkan" | false;
  /**
   * Softmax temperature for the label readout. Small models put ~100% on one label even when the
   * logit gaps are informative; T > 1 keeps the ordering but spreads probabilities (default 1).
   */
  readoutTemperature?: number;
  log?: (msg: string) => void;
}

export interface EngineStatus {
  phase: ModelPhase;
  name: string;
  progress?: number;
  error?: string;
}

/**
 * Owns the model lifecycle and a pool of context sequences.
 * One systemOne() call runs all its questions on a single sequence so the shared prefix
 * (system prompt + state) is prefilled once and only the question tail is re-evaluated.
 */
export class SystemOneEngine {
  private llama: Llama | undefined;
  private model: LlamaModel | undefined;
  private context: LlamaContext | undefined;
  private readonly idle: LlamaContextSequence[] = [];
  private readonly waiters: Array<(seq: LlamaContextSequence) => void> = [];
  private readonly labelTokenCache = new Map<string, Token>();
  private status: EngineStatus;
  private readonly log: (msg: string) => void;
  /** Foreground (request-driven) calls in flight; background work yields while this is > 0. */
  private foreground = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly opts: EngineOptions) {
    this.log = opts.log ?? (() => {});
    this.status = { phase: "idle", name: opts.modelUri };
  }

  getStatus(): EngineStatus {
    return { ...this.status };
  }

  get isReady(): boolean {
    return this.status.phase === "ready";
  }

  /** Download (if needed), load and warm up the model. Called once at server start. */
  async start(): Promise<void> {
    try {
      this.status = { phase: "downloading", name: this.opts.modelUri, progress: 0 };
      let lastLogged = -1;
      const modelPath = await resolveModelFile(this.opts.modelUri, {
        directory: this.opts.modelsDir,
        cli: false,
        onProgress: ({ totalSize, downloadedSize }) => {
          const p = totalSize > 0 ? downloadedSize / totalSize : 0;
          this.status = { phase: "downloading", name: this.opts.modelUri, progress: p };
          const pct = Math.floor(p * 20) * 5;
          if (pct !== lastLogged) {
            lastLogged = pct;
            this.log(`downloading model… ${pct}% (${(downloadedSize / 1e6).toFixed(0)} / ${(totalSize / 1e6).toFixed(0)} MB)`);
          }
        },
      });

      this.status = { phase: "loading", name: this.opts.modelUri };
      this.log(`loading ${modelPath}`);
      this.llama = await getLlama({ gpu: this.opts.gpu, logLevel: LlamaLogLevel.error });
      this.model = await this.llama.loadModel({ modelPath });
      this.context = await this.model.createContext({
        sequences: this.opts.sequences,
        contextSize: this.opts.contextSize,
        batchSize: Math.max(512, this.opts.contextSize),
        flashAttention: "auto",
      });
      for (let i = 0; i < this.opts.sequences; i++) this.idle.push(this.context.getSequence());

      // Warm-up: compiles GPU kernels and proves the label tokens are single tokens.
      const t0 = performance.now();
      const warm = await this.systemOne({
        state: { note: "warm-up" },
        questions: { ok: { type: "noul", instructions: "Is this a warm-up?" } },
      });
      this.log(`model ready (gpu=${this.llama.gpu}, warm-up ${Math.round(performance.now() - t0)} ms, noul=${warm.answers.ok.noul.toFixed(2)})`);
      this.status = { phase: "ready", name: this.describeModel() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { phase: "error", name: this.opts.modelUri, error: message };
      this.log(`model failed to start: ${message}`);
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.context?.dispose();
    await this.model?.dispose();
    await this.llama?.dispose();
    this.status = { phase: "idle", name: this.opts.modelUri };
  }

  describeModel(): string {
    const uri = this.opts.modelUri;
    const m = /^hf:([^:]+?)(?::([^:]+))?$/.exec(uri);
    return m ? `${m[1]}${m[2] ? ` (${m[2]})` : ""}` : uri;
  }

  /** Resolves once no foreground call is running (used by background prefetching). */
  whenIdle(): Promise<void> {
    if (this.foreground === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * The System One call: one state, many typed questions, probabilities out.
   * `priority: "background"` marks work that should never slow a user request down.
   */
  async systemOne<Q extends Record<string, Question>>(req: SystemOneRequest<Q>, priority: "foreground" | "background" = "foreground"): Promise<SystemOneResponse<Q>> {
    const model = this.model;
    if (!model || !this.context) throw new Error("model not loaded");
    if (priority === "background") await this.whenIdle();
    else this.foreground++;
    const t0 = performance.now();
    const stateText = renderState(req.state);
    const seq = await this.acquire();
    let inputTokens = 0;
    let evaluatedTokens = 0;
    try {
      const answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer> = {};
      for (const [key, question] of Object.entries(req.questions)) {
        const rendered = renderQuestion(question);
        const { prefix, suffix } = buildPrompt(stateText, rendered.text);
        const tokens = model.tokenize(prefix + suffix, true);
        if (tokens.length >= seq.contextSize) {
          throw new Error(`prompt too long for context (${tokens.length} >= ${seq.contextSize} tokens)`);
        }
        inputTokens += tokens.length;
        const probs = await this.readout(seq, tokens, rendered.labels);
        evaluatedTokens += probs.evaluated;
        answers[key] = toAnswer(question, probs.probabilities, probs.labelMass);
      }
      return {
        answers: answers as Answers<Q>,
        model: this.describeModel(),
        usage: { inputTokens, evaluatedTokens, questions: Object.keys(req.questions).length, ms: performance.now() - t0 },
      };
    } finally {
      this.release(seq);
      if (priority === "foreground" && --this.foreground === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  /**
   * Prefill the prompt (re-using whatever prefix the sequence already holds) and read the logits of the
   * label tokens for the next position. Returns a softmax over the labels only, plus how much of the full
   * vocabulary's probability mass those labels captured (a sanity signal for confidence).
   */
  private async readout(seq: LlamaContextSequence, tokens: Token[], labels: string[]) {
    const model = this.model!;
    const labelTokens = labels.map((l) => this.labelToken(model, l));

    await seq.adaptStateToTokens(tokens, false);
    if (seq.nextTokenIndex >= tokens.length) {
      // Identical prompt already evaluated: drop the last token so we get fresh logits for it.
      await seq.eraseContextTokenRanges([{ start: tokens.length - 1, end: seq.nextTokenIndex }]);
    }
    const pending = tokens.slice(seq.nextTokenIndex);
    const last = pending.pop()!;
    const input: Parameters<LlamaContextSequence["controlledEvaluate"]>[0] = [
      ...pending,
      [last, { generateNext: { logits: { filter: { tokens: labelTokens, includeMax: true } }, totalLogitWeight: true } }],
    ];
    const out = await seq.controlledEvaluate(input);
    const result = out[input.length - 1];
    const logits = result?.next.logits;
    if (!logits) throw new Error("model returned no logits");

    let maxLogit = -Infinity;
    for (const v of logits.values()) maxLogit = Math.max(maxLogit, v);
    const temperature = Math.max(0.05, this.opts.readoutTemperature ?? 1);
    const weights = labelTokens.map((t) => Math.exp(((logits.get(t) ?? -1e9) - maxLogit) / temperature));
    const sum = weights.reduce((a, b) => a + b, 0);
    const probabilities = weights.map((w) => (sum > 0 ? w / sum : 1 / weights.length));
    const rawSum = labelTokens.reduce((acc, t) => acc + Math.exp((logits.get(t) ?? -1e9) - maxLogit), 0);
    const total = result?.next.totalLogitWeight ?? rawSum;
    const labelMass = total > 0 ? Math.min(1, rawSum / total) : 0;
    return { probabilities, labelMass, evaluated: input.length };
  }

  private labelToken(model: LlamaModel, label: string): Token {
    const cached = this.labelTokenCache.get(label);
    if (cached !== undefined) return cached;
    const toks = model.tokenize(label, false);
    if (toks.length !== 1 || toks[0] === undefined) {
      throw new Error(`label "${label}" is not a single token in this tokenizer (${toks.length} tokens)`);
    }
    this.labelTokenCache.set(label, toks[0]);
    return toks[0];
  }

  private acquire(): Promise<LlamaContextSequence> {
    const seq = this.idle.pop();
    if (seq) return Promise.resolve(seq);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(seq: LlamaContextSequence): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(seq);
    else this.idle.push(seq);
  }
}

function toAnswer(question: Question, probabilities: number[], labelMass: number): NoulAnswer | ChoiceAnswer | ScoreAnswer {
  switch (question.type) {
    case "noul": {
      const yes = probabilities[0] ?? 0;
      return { type: "noul", noul: yes, confidence: Math.abs(2 * yes - 1) * labelMass };
    }
    case "choice": {
      const ids = Object.keys(question.criteria);
      const probs: Record<string, number> = {};
      let best = 0;
      ids.forEach((id, i) => {
        probs[id] = probabilities[i] ?? 0;
        if ((probabilities[i] ?? 0) > (probabilities[best] ?? 0)) best = i;
      });
      return { type: "choice", choice: ids[best]!, probabilities: probs, confidence: (probabilities[best] ?? 0) * labelMass };
    }
    case "score": {
      const probs: Record<string, number> = {};
      let expected = 0;
      let peak = 0;
      probabilities.forEach((p, i) => {
        probs[String(i)] = p;
        expected += p * i;
        peak = Math.max(peak, p);
      });
      return { type: "score", score: expected, probabilities: probs, confidence: peak * labelMass };
    }
  }
}
