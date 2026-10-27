// PPTX の発表者ノートを、スライドの順に取り出す
import assert from "node:assert/strict";
import { test } from "node:test";
import { notesText, pptxNotes } from "./pptxNotes.ts";
import { notesXml, samplePptx } from "./pptxFixture.ts";

test("発表者ノートを、表示するスライドの順に取り出す（非表示のスライドは飛ばす）", () => {
  assert.deepEqual(pptxNotes(samplePptx()), ["最初に背景を話す\nQ & A は最後", ""]);
});

test("ノートの本文の欄だけを読む。スライド番号の欄は読まない", () => {
  assert.equal(notesText(notesXml("一行目", "", "三行目")), "一行目\n\n三行目");
});

test("ZIP でないものや壊れたものは空の配列", () => {
  assert.deepEqual(pptxNotes(new TextEncoder().encode("PK\u0003\u0004 fake pptx").buffer as ArrayBuffer), []);
  assert.deepEqual(pptxNotes(new ArrayBuffer(0)), []);
});
