/**
 * A local re-implementation of the TypeSafe "System One" interface popularised by Jev / OpenJev:
 * state in, typed probabilistic decisions out. No text is generated – every answer is read directly
 * from the next-token logits of a small local model in a single forward pass per question.
 */

export interface NoulQuestion {
  type: "noul";
  /** A yes/no question about the state. */
  instructions: string;
}

export interface ChoiceQuestion<K extends string = string> {
  type: "choice";
  instructions: string;
  /** Option id → description (null when the id is self-explanatory). Max 26 options. */
  criteria: Record<K, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered anchors from lowest (index 0) to highest. Max 10 anchors. */
  criteria: readonly string[];
}

export type Question = NoulQuestion | ChoiceQuestion<string> | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** Probability of "yes", 0..1. */
  noul: number;
  /** How decisive the answer was, 0..1 (|2p-1| scaled by label mass). */
  confidence: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  choice: K;
  probabilities: Record<K, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted anchor index, 0..criteria.length-1. */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** Structured program state. Nested objects/arrays are rendered as an indented outline for the model. */
export type State = Record<string, unknown>;

export interface SystemOneRequest<Q extends Record<string, Question>> {
  state: State;
  questions: Q;
}

export interface SystemOneResponse<Q extends Record<string, Question>> {
  answers: Answers<Q>;
  model: string;
  usage: { inputTokens: number; evaluatedTokens: number; questions: number; ms: number };
}

export const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
export const choice = <K extends string>(instructions: string, criteria: Record<K, string | null>): ChoiceQuestion<K> => ({
  type: "choice",
  instructions,
  criteria,
});
export const score = (instructions: string, criteria: readonly string[]): ScoreQuestion => ({ type: "score", instructions, criteria });
