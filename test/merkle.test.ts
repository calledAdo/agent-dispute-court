import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, keccak256, pad, toHex } from "viem";
import type { Hex } from "viem";
import { buildTree, receiptLeaf, verifyProof } from "../shared/merkle.ts";

const leafN = (n: number): Hex => keccak256(toHex(`leaf-${n}`));

for (const n of [1, 2, 3, 5, 8]) {
  test(`root and proofs for ${n} leaves`, () => {
    const leaves = Array.from({ length: n }, (_, i) => leafN(i));
    const tree = buildTree(leaves);
    for (let i = 0; i < n; i++) assert.ok(verifyProof(tree.root, i, leaves[i], tree.proof(i)));
  });
}

test("zero leaves throws", () => assert.throws(() => buildTree([])));

test("proofs fail for edited leaf, wrong index, wrong root", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => leafN(i));
  const tree = buildTree(leaves);
  const p = tree.proof(2);
  assert.equal(verifyProof(tree.root, 2, leafN(99), p), false);
  assert.equal(verifyProof(tree.root, 3, leaves[2], p), false);
  assert.equal(verifyProof(leafN(7), 2, leaves[2], p), false);
});

test("fixed vector for values 11 and 22", () => {
  const l11 = pad(toHex(11), { size: 32 });
  const l22 = pad(toHex(22), { size: 32 });
  const h = (l: Hex) => keccak256(concat(["0x00", l]));
  const expected = keccak256(concat(["0x01", h(l11), h(l22)]));
  assert.equal(buildTree([l11, l22]).root, expected);
});

test("padding uses the zero leaf", () => {
  const zero = pad("0x00", { size: 32 });
  const a = [leafN(1), leafN(2), leafN(3)];
  assert.equal(buildTree(a).root, buildTree([...a, zero]).root);
});

test("receiptLeaf encoding", () => {
  const r = { tx: "0xa", resource: "/x", requestHash: "0xb", responseHash: "0xc" };
  assert.equal(receiptLeaf(r), keccak256(toHex('["0xa","/x","0xb","0xc"]')));
});
