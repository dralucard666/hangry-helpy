import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, renderQuestion, renderState } from "./prompt.ts";
import { choice, noul, score } from "./types.ts";

test("renderState renders nested objects as an outline", () => {
  const out = renderState({ user_wants: { diet: "vegan", budget: "cheap" }, candidate: "Buns is a burger place." });
  assert.equal(out, "user wants:\n  diet: vegan\n  budget: cheap\ncandidate: Buns is a burger place.");
});

test("noul question reads yes/no labels", () => {
  const r = renderQuestion(noul("Is it open?"));
  assert.deepEqual(r.labels, ["yes", "no"]);
  assert.match(r.text, /yes or no/);
});

test("choice question maps option ids to letters", () => {
  const r = renderQuestion(choice("Pick", { pizza: "Italian", sushi: null }));
  assert.deepEqual(r.labels, ["A", "B"]);
  assert.match(r.text, /A: pizza — Italian\nB: sushi/);
});

test("score question uses digit labels and rejects too many anchors", () => {
  const r = renderQuestion(score("How good?", ["bad", "ok", "great"]));
  assert.deepEqual(r.labels, ["0", "1", "2"]);
  assert.throws(() => renderQuestion(score("x", Array.from({ length: 11 }, (_, i) => `a${i}`))));
});

test("prompt pre-fills an empty think block so the next token is the answer", () => {
  const { prefix, suffix } = buildPrompt("STATE", "QUESTION");
  assert.ok(prefix.startsWith("<|im_start|>system"));
  assert.ok(suffix.endsWith("<think>\n\n</think>\n\n"));
});
