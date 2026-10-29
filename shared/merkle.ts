import { concat, keccak256, toHex } from "viem";
import type { Hex } from "viem";

const ZERO_LEAF: Hex = `0x${"00".repeat(32)}`;

export function receiptLeaf(r: { tx: string; resource: string; requestHash: string; responseHash: string }): Hex {
  return keccak256(toHex(JSON.stringify([r.tx, r.resource, r.requestHash, r.responseHash])));
}

const hashLeaf = (leaf: Hex): Hex => keccak256(concat(["0x00", leaf]));
const hashNode = (left: Hex, right: Hex): Hex => keccak256(concat(["0x01", left, right]));

export function buildTree(leaves: Hex[]): { root: Hex; proof(index: number): Hex[] } {
  if (leaves.length === 0) throw new Error("cannot build a Merkle tree with zero leaves");
  let size = 1;
  while (size < leaves.length) size *= 2;
  const padded = [...leaves, ...Array<Hex>(size - leaves.length).fill(ZERO_LEAF)];
  const levels: Hex[][] = [padded.map(hashLeaf)];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(hashNode(prev[i], prev[i + 1]));
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1][0],
    proof(index: number): Hex[] {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error(`leaf index out of range: ${index}`);
      const siblings: Hex[] = [];
      let i = index;
      for (let l = 0; l < levels.length - 1; l++) {
        siblings.push(levels[l][i ^ 1]);
        i >>= 1;
      }
      return siblings;
    },
  };
}

// Mirrors CourtLedger.proves: sibling side is chosen by index bit i (LSB first).
export function verifyProof(root: Hex, index: number, leaf: Hex, siblings: Hex[]): boolean {
  let h = hashLeaf(leaf);
  for (let i = 0; i < siblings.length; i++) {
    h = Math.floor(index / 2 ** i) % 2 === 0 ? hashNode(h, siblings[i]) : hashNode(siblings[i], h);
  }
  return h.toLowerCase() === root.toLowerCase();
}
