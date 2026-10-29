# T3: Merkle anchoring of delivery receipts

The seller periodically commits a Merkle root of its receipts to `CourtLedger` (`contracts/CourtLedger.sol`, already deployed on testnet at `0x2528db9267bd6bc9950ab74ad83d748b64e18042`). The court later proves a single receipt against the on-chain root.

## Allowed dependencies
`viem` (already installed) and `solc@0.8.28` (dev; for compiling the contracts to ABI/bytecode JSON).

## Files
- `shared/merkle.ts`: pure, no network. **Hashing must match MetalAssertions' Merkle-leaf format and `CourtLedger.proves`:**
  - leaf hash `keccak256(0x00 ‖ leaf)`;
  - node hash `keccak256(0x01 ‖ left ‖ right)`;
  - pad the leaf list to a power of two with the leaf `0x00…00` (32 zero bytes);
  - sibling order follows the index bits, least significant first.

  Exports:
  - `receiptLeaf(r: { tx: string; resource: string; requestHash: string; responseHash: string }): Hex`, equal to `keccak256(toHex(JSON.stringify([tx, resource, requestHash, responseHash])))`. Keep this exact encoding; it was used on chain already.
  - `buildTree(leaves: Hex[]): { root: Hex; proof(index: number): Hex[] }`. A single leaf works. Zero leaves throws.
  - `verifyProof(root: Hex, index: number, leaf: Hex, siblings: Hex[]): boolean`. The same algorithm as `CourtLedger.proves`.
- `scripts/compile.ts`: compiles every `contracts/*.sol` with solc 0.8.28 (`evmVersion "cancun"`, optimizer on, 200 runs) into `contracts/build/<Name>.json` (`{ abi, bytecode }`). Commit the build output.
- `seller/anchor.ts`: `anchorBatch({ publicClient, walletClient, ledger, receipts, uri }): Promise<{ batch: bigint; root: Hex; tx: Hex; indexOf: Record<string, number> }>`.
  - Builds the tree in the order given.
  - Calls `commit(root, count, uri)`. **On Metal you must pass explicit `gas: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n`**, because gas estimation fails there.
  - Waits for the receipt, decodes `DeliveriesCommitted`, and returns `indexOf` (tx → leaf index).
  - Clients are injected; this module never creates keys.
- `test/merkle.test.ts`:
  - roots and proofs for 1, 2, 3, 5 and 8 leaves;
  - a proof fails for an edited leaf, a wrong index, and a wrong root;
  - **a fixed vector:** the leaf hashes `keccak256(0x00‖0x…0b)` and `keccak256(0x00‖0x…16)` (the values 11 and 22 as bytes32) must give the root `keccak256(0x01 ‖ h(11) ‖ h(22))`. Compute the expected value in the test from first principles with viem, not with the code under test.

## Out of scope
Deploying contracts, private keys, cron scheduling.
