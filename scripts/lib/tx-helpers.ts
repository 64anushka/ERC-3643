import { ethers } from 'hardhat';
import { Contract, ContractReceipt, ContractTransaction, Signer, Wallet, providers } from 'ethers';

const RETRYABLE_MESSAGES = ['in-flight transaction limit reached', 'gapped-nonce tx from delegated accounts'];
const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return RETRYABLE_MESSAGES.some((m) => lower.includes(m));
}

/**
 * Retries `fn` on "in-flight transaction limit reached" - seen on Sepolia
 * for EIP-7702 delegated accounts, which some nodes hard-cap to one pending
 * transaction. Even when every transaction here is only sent after the
 * previous one is confirmed, the provider's own in-flight bookkeeping can
 * lag a few seconds behind the chain, so the very next transaction can
 * still be rejected. Uses exponential backoff since that lag is variable.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`  ${label}: in-flight transaction limit hit, retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(delayMs);
    }
  }
}

/**
 * After a deployment is mined, a load-balanced RPC node may not serve its code yet. The next transaction that
 * touches the new contract (e.g. a proxy pointing at it) would then fail gas estimation with
 * "new implementation is not a contract". Wait until the code is visible (up to ~30s).
 */
async function waitForCode(address: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await ethers.provider.getCode(address)) !== '0x') return;
    await sleep(1500);
  }
}

/** Optional observer (used by the demo UI) notified every time a transaction is mined. */
export const txHooks: { onMined?: (label: string, hash: string, address?: string) => void } = {};

/** Deploys a contract and waits for it to be mined, retrying through transient in-flight-limit rejections. */
export async function deployAndWait(name: string, args: unknown[], signer: Signer): Promise<Contract> {
  return withRetry(async () => {
    const contract = await ethers.deployContract(name, args, signer);
    await contract.deployTransaction.wait();
    await waitForCode(contract.address);
    txHooks.onMined?.(`deploy ${name}`, contract.deployTransaction.hash, contract.address);
    return contract;
  }, `deploy ${name}`);
}

/**
 * Sends a transaction and waits for it to be mined, retrying through transient
 * in-flight-limit rejections. `sendTx` must be a thunk (not an already-sent
 * transaction) so a retry re-sends from scratch - safe here because this
 * provider error means the node rejected the transaction outright, so it was
 * never broadcast.
 */
export async function sendAndWait(sendTx: () => Promise<ContractTransaction>, label: string): Promise<ContractReceipt> {
  return withRetry(async () => {
    const tx = await sendTx();
    const receipt = await tx.wait();
    txHooks.onMined?.(label, tx.hash);
    return receipt;
  }, label);
}

/** Deploys a contract from a raw ABI + bytecode (e.g. the @onchain-id/solidity artifacts) and waits for it to be mined. */
export async function deployArtifactAndWait(
  artifact: { abi: any; bytecode: string },
  args: unknown[],
  signer: Signer,
  label: string,
): Promise<Contract> {
  return withRetry(async () => {
    const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.deployTransaction.wait();
    await waitForCode(contract.address);
    txHooks.onMined?.(`deploy ${label}`, contract.deployTransaction.hash, contract.address);
    return contract;
  }, `deploy ${label}`);
}

/**
 * Wallet that always takes its nonce from the last *mined* transaction count (never "pending"), bumped
 * by a local counter after each send. Delegated (EIP-7702) accounts on Sepolia only allow one pending
 * transaction, and nodes then answer "pending" nonce queries inconsistently, which surfaces as
 * "gapped-nonce tx from delegated accounts". Every tx in these scripts is awaited before the next is
 * sent, so the mined count is the right nonce; the local counter covers RPC nodes that lag behind.
 */
export class MinedNonceWallet extends Wallet {
  private nextNonce = 0;

  async getTransactionCount(_blockTag?: providers.BlockTag): Promise<number> {
    // If the node still reports fewer mined txs than we have already sent, it is lagging behind: submitting
    // the higher local nonce to it is exactly what produces "gapped-nonce tx from delegated accounts".
    // Wait (briefly) for the node to catch up so the nonce we use equals its current account nonce.
    let mined = await super.getTransactionCount('latest');
    for (let i = 0; i < 20 && mined < this.nextNonce; i++) {
      await sleep(1500);
      mined = await super.getTransactionCount('latest');
    }
    return Math.max(mined, this.nextNonce);
  }

  async sendTransaction(tx: providers.TransactionRequest): Promise<providers.TransactionResponse> {
    const response = await super.sendTransaction(tx);
    this.nextNonce = response.nonce + 1;
    return response;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

/** Wall-clock timer for deployment steps: logs each step as it finishes and prints a per-phase summary table. */
export class StepTimer {
  private readonly startedAt = Date.now();
  private currentPhase = '';
  private readonly steps: { phase: string; label: string; ms: number }[] = [];

  phase(name: string): void {
    this.currentPhase = name;
  }

  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - start;
      this.steps.push({ phase: this.currentPhase, label, ms });
      console.log(`  [time] ${label}: ${formatDuration(ms)}`);
    }
  }

  summary(): void {
    console.log('\n=== Timing summary ===');
    let phase = '';
    let phaseTotal = 0;
    const flush = () => {
      if (phase) console.log(`  ${`>> ${phase} total`.padEnd(56)}${formatDuration(phaseTotal)}`);
    };
    for (const step of this.steps) {
      if (step.phase !== phase) {
        flush();
        phase = step.phase;
        phaseTotal = 0;
        console.log(`\n${phase}`);
      }
      phaseTotal += step.ms;
      console.log(`  ${step.label.padEnd(56)}${formatDuration(step.ms)}`);
    }
    flush();
    console.log(`\nTotal elapsed: ${formatDuration(Date.now() - this.startedAt)}`);
  }
}
