import { ethers } from 'hardhat';
import { BigNumber, Contract, Event } from 'ethers';
import OnchainID from '@onchain-id/solidity';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { randomUUID } from 'crypto';
import { deployAndWait, deployArtifactAndWait, MinedNonceWallet, sendAndWait, txHooks } from '../lib/tx-helpers';

/**
 * Local demo UI for the KMS-backed Sepolia deployment: one button per step of
 * scripts/deploy-sepolia-kms.ts, live progress, tx links and logs.
 *
 * Run with: npm run ui:sepolia-kms   (then open http://127.0.0.1:3000)
 *
 * Binds to 127.0.0.1 only. Same env vars as deploy-sepolia-kms.ts. Progress (completed steps and
 * deployed addresses) is saved to scripts/ui/.state.json so a restart picks up where you left off.
 */

const PORT = Number(process.env.UI_PORT || 3000);
const SEPOLIA_CHAIN_ID = 11155111;
const EXPLORER = 'https://sepolia.etherscan.io';
const STATE_FILE = path.join(__dirname, '.state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Deal configuration - keep in sync with deploy-sepolia-kms.ts
const TOKEN_NAME = 'ACME Corp / 3.875% Fixed EMTN';
const TOKEN_SYMBOL = 'TR-51X5RT-01';
const TOKEN_DECIMALS = 0;
const SUPPLY_LIMIT = 5000;
const PRICE_PER_BOND = BigNumber.from(99_900_000);

type Status = 'pending' | 'running' | 'done' | 'error';
interface StepRuntime {
  status: Status;
  txDone: number;
  durationMs?: number;
  startedAt?: number;
  error?: string;
}
interface TxRecord {
  step: string;
  label: string;
  hash: string;
}
interface Persisted {
  addresses: Record<string, string>;
  steps: Record<string, StepRuntime>;
  txs: TxRecord[];
  /** Investor label -> the MetaMask account assigned to that investor */
  investors: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Runtime context (set up in init())
// ---------------------------------------------------------------------------
let admin: MinedNonceWallet;
let adminAddress = '';
/** Investors sign in the browser with MetaMask, so the server only knows their addresses. */
const INVESTORS = [
  { label: 'Aurora', bonds: 2000 },
  { label: 'Northbridge', bonds: 1500 },
  { label: 'Meridian', bonds: 1500 },
];
let initError: string | undefined;
let ready = false;

let state: Persisted = { addresses: {}, steps: {}, txs: [], investors: {} };
let runningStep: string | undefined;
let runningPhase: string | undefined;

function investorAddress(label: string): string {
  const address = state.investors[label];
  if (!address) throw new Error(`No MetaMask account assigned to ${label} yet - assign the investor accounts first.`);
  return address;
}
const investorsAssigned = () => INVESTORS.every((i) => !!state.investors[i.label]);

// --- MetaMask hand-off: the server prepares an investor transaction, the browser signs and sends it ---
interface PendingTx {
  id: string;
  investor: string;
  from: string;
  to: string;
  data: string;
  description: string;
}
let pendingTx: PendingTx | undefined;
let pendingSettle: { id: string; resolve: (hash: string) => void; reject: (e: Error) => void } | undefined;
const METAMASK_TIMEOUT_MS = 10 * 60_000;

async function investorSend(investorLabel: string, label: string, populated: { to?: string; data?: string }, description: string): Promise<void> {
  const from = investorAddress(investorLabel);
  const id = randomUUID();
  pendingTx = { id, investor: investorLabel, from, to: populated.to as string, data: populated.data as string, description };
  console.log(`  waiting for ${investorLabel} (${from}) to confirm in MetaMask: ${description}`);
  emit();
  let hash: string;
  try {
    hash = await new Promise<string>((resolve, reject) => {
      pendingSettle = { id, resolve, reject };
      setTimeout(() => reject(new Error('Timed out waiting for the MetaMask confirmation')), METAMASK_TIMEOUT_MS);
    });
  } finally {
    pendingTx = undefined;
    pendingSettle = undefined;
    emit();
  }
  const receipt = await ethers.provider.waitForTransaction(hash, 1, 5 * 60_000);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed on chain (${hash})`);
  txHooks.onMined?.(label, hash);
}

/** Runs a sub-action once; a retried step skips what already succeeded. */
async function once(key: string, fn: () => Promise<unknown>): Promise<void> {
  if (A()[`done:${key}`]) {
    console.log(`  already done earlier: ${key}`);
    return;
  }
  await fn();
  A()[`done:${key}`] = '1';
  saveState();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return value;
}

const A = () => state.addresses;
const at = (name: string, address: string): Promise<Contract> => ethers.getContractAt(name, address, admin) as Promise<Contract>;

/** Deploys once and remembers the address, so retrying a step never redeploys what already succeeded. */
async function deployOnce(key: string, name: string, args: unknown[] = []): Promise<Contract> {
  if (A()[key]) {
    console.log(`  reusing ${name} already deployed at ${A()[key]}`);
    return at(name, A()[key]);
  }
  const contract = await deployAndWait(name, args, admin);
  A()[key] = contract.address;
  saveState();
  return contract;
}

// ---------------------------------------------------------------------------
// Steps (mirrors deploy-sepolia-kms.ts)
// ---------------------------------------------------------------------------
interface StepDef {
  id: string;
  phase: 'A' | 'B' | 'C';
  title: string;
  desc: string;
  signer: 'kms' | 'mixed';
  expectedTx: number;
  run: () => Promise<void>;
}

const swapStep = (i: number): StepDef => ({
  id: `11-${['aurora', 'northbridge', 'meridian'][i]}`,
  phase: 'C',
  title: `DVD swap with ${['Aurora', 'Northbridge', 'Meridian'][i]}`,
  desc: `B&D offers ${[2000, 1500, 1500][i]} bonds, the investor accepts, bonds and EURd swap atomically`,
  signer: 'mixed',
  expectedTx: 2,
  run: async () => {
    const investor = INVESTORS[i];
    const investorAddr = investorAddress(investor.label);
    const cashAmount = PRICE_PER_BOND.mul(investor.bonds);
    const dvd = await at('DVDTransferManager', A().dvd);
    const token = await at('Token', A().token);
    const cashToken = await at('MockCashToken', A().cashToken);
    // 1) B&D (admin, signed by the server) offers the trade; the transfer ID is remembered so a retry never offers twice
    const idKey = `transfer:${investor.label}`;
    let transferID = A()[idKey];
    if (!transferID) {
      const initiateReceipt = await sendAndWait(
        () => dvd.connect(admin).initiateDVDTransfer(token.address, investor.bonds, investorAddr, cashToken.address, cashAmount),
        `initiateDVDTransfer(${investor.label})`,
      );
      const initiatedEvent = initiateReceipt.events?.find((e: Event) => e.event === 'DVDTransferInitiated');
      transferID = initiatedEvent?.args?.transferID as string;
      A()[idKey] = transferID;
      saveState();
    }
    // 2) The investor accepts in MetaMask
    const take = await dvd.populateTransaction.takeDVDTransfer(transferID);
    await investorSend(
      investor.label,
      `takeDVDTransfer(${investor.label})`,
      take,
      `Accept the trade: ${investor.bonds.toLocaleString()} bonds for ${ethers.utils.formatUnits(cashAmount, 6)} EURd`,
    );
    console.log(`Settled ${investor.bonds} bonds <-> ${ethers.utils.formatUnits(cashAmount, 6)} EURd with ${investor.label}`);
  },
});

const STEPS: StepDef[] = [
  {
    id: '1',
    phase: 'A',
    title: 'Deploy implementation contracts',
    desc: 'Token, ClaimTopicsRegistry, TrustedIssuersRegistry, IdentityRegistryStorage, IdentityRegistry, ModularCompliance',
    signer: 'kms',
    expectedTx: 6,
    run: async () => {
      await deployOnce('tokenImpl', 'Token');
      await deployOnce('ctrImpl', 'ClaimTopicsRegistry');
      await deployOnce('tirImpl', 'TrustedIssuersRegistry');
      await deployOnce('irsImpl', 'IdentityRegistryStorage');
      await deployOnce('irImpl', 'IdentityRegistry');
      await deployOnce('mcImpl', 'ModularCompliance');
    },
  },
  {
    id: '2',
    phase: 'A',
    title: 'Implementation Authority + version 1.0.0',
    desc: 'TREXImplementationAuthority, registered with the six implementations',
    signer: 'kms',
    expectedTx: 2,
    run: async () => {
      const authority = await deployOnce('ia', 'TREXImplementationAuthority', [true, ethers.constants.AddressZero, ethers.constants.AddressZero]);
      const implementations = {
        tokenImplementation: A().tokenImpl,
        ctrImplementation: A().ctrImpl,
        irImplementation: A().irImpl,
        irsImplementation: A().irsImpl,
        tirImplementation: A().tirImpl,
        mcImplementation: A().mcImpl,
      };
      await sendAndWait(() => authority.connect(admin).addAndUseTREXVersion({ major: 1, minor: 0, patch: 0 }, implementations), 'addAndUseTREXVersion');
    },
  },
  {
    id: '3',
    phase: 'A',
    title: 'ONCHAINID IdFactory + TREXFactory',
    desc: 'Identity implementation and authority, IdFactory, TREXFactory, then link them',
    signer: 'kms',
    expectedTx: 5,
    run: async () => {
      const identityImplementation = await deployArtifactAndWait(OnchainID.contracts.Identity, [adminAddress, true], admin, 'Identity');
      const identityIa = await deployArtifactAndWait(OnchainID.contracts.ImplementationAuthority, [identityImplementation.address], admin, 'ONCHAINID ImplementationAuthority');
      const idFactory = await deployArtifactAndWait(OnchainID.contracts.Factory, [identityIa.address], admin, 'IdFactory');
      const factory = await deployAndWait('TREXFactory', [A().ia, idFactory.address], admin);
      await sendAndWait(() => idFactory.connect(admin).addTokenFactory(factory.address), 'idFactory.addTokenFactory');
      A().idFactory = idFactory.address;
      A().factory = factory.address;
    },
  },
  {
    id: '4',
    phase: 'A',
    title: 'TREXGateway + ownership + deployer',
    desc: 'The access-controlled front door; factory ownership moves to the gateway',
    signer: 'kms',
    expectedTx: 3,
    run: async () => {
      const factory = await at('TREXFactory', A().factory);
      const gateway = await deployAndWait('TREXGateway', [factory.address, false], admin);
      await sendAndWait(() => factory.connect(admin).transferOwnership(gateway.address), 'factory.transferOwnership');
      await sendAndWait(() => gateway.connect(admin).addDeployer(adminAddress), 'gateway.addDeployer');
      A().gateway = gateway.address;
    },
  },
  {
    id: '5',
    phase: 'A',
    title: 'SupplyLimitModule + ModuleProxy',
    desc: 'Upgradeable compliance module shared across deals',
    signer: 'kms',
    expectedTx: 2,
    run: async () => {
      const implementation = await deployOnce('supplyLimitImpl', 'SupplyLimitModule');
      const initData = implementation.interface.encodeFunctionData('initialize');
      const proxy = await deployAndWait('ModuleProxy', [implementation.address, initData], admin);
      A().supplyLimitModule = proxy.address;
    },
  },
  {
    id: '6',
    phase: 'A',
    title: 'MockCashToken + DVDTransferManager',
    desc: 'Test EURd cash token and the atomic delivery-versus-payment engine',
    signer: 'kms',
    expectedTx: 2,
    run: async () => {
      await deployOnce('cashToken', 'MockCashToken', [adminAddress]);
      await deployOnce('dvd', 'DVDTransferManager');
    },
  },
  {
    id: '7',
    phase: 'B',
    title: 'gateway.deployTREXSuite',
    desc: 'One transaction deploys the full 6-contract suite for the bond',
    signer: 'kms',
    expectedTx: 1,
    run: async () => {
      const gateway = await at('TREXGateway', A().gateway);
      const factory = await at('TREXFactory', A().factory);
      const supplyLimitModule = await at('SupplyLimitModule', A().supplyLimitModule);
      const tokenDetails = {
        owner: adminAddress,
        name: TOKEN_NAME,
        symbol: TOKEN_SYMBOL,
        decimals: TOKEN_DECIMALS,
        irs: ethers.constants.AddressZero,
        ONCHAINID: ethers.constants.AddressZero,
        irAgents: [adminAddress],
        tokenAgents: [adminAddress],
        complianceModules: [supplyLimitModule.address],
        complianceSettings: [supplyLimitModule.interface.encodeFunctionData('setSupplyLimit', [SUPPLY_LIMIT])],
      };
      await sendAndWait(() => gateway.connect(admin).deployTREXSuite(tokenDetails, { claimTopics: [], issuers: [], issuerClaims: [] }), 'deployTREXSuite');
      const tokenAddress = await factory.getToken(`${adminAddress.toLowerCase()}${TOKEN_NAME}`);
      const token = await ethers.getContractAt('Token', tokenAddress);
      A().token = tokenAddress;
      A().identityRegistry = await token.identityRegistry();
      A().compliance = await token.compliance();
    },
  },
  {
    id: '8',
    phase: 'C',
    title: 'Whitelist wallets',
    desc: 'Registrar registers the admin and the three MetaMask investor accounts',
    signer: 'kms',
    expectedTx: 1,
    run: async () => {
      const identityRegistry = await at('IdentityRegistry', A().identityRegistry);
      // An identity can only be registered once, so a MetaMask account shared by several investors is registered once.
      const wallets = Array.from(new Map([adminAddress, ...INVESTORS.map((i) => investorAddress(i.label))].map((a) => [a.toLowerCase(), a])).values());
      await sendAndWait(
        () => identityRegistry.connect(admin).batchRegisterIdentity(wallets, wallets, wallets.map(() => 0)),
        'batchRegisterIdentity',
      );
    },
  },
  {
    id: '9',
    phase: 'C',
    title: 'Mint supply + unpause',
    desc: `B&D mints ${SUPPLY_LIMIT.toLocaleString()} bonds to itself and unpauses the token`,
    signer: 'kms',
    expectedTx: 2,
    run: async () => {
      const token = await at('Token', A().token);
      await sendAndWait(() => token.connect(admin).mint(adminAddress, SUPPLY_LIMIT), 'token.mint');
      await sendAndWait(() => token.connect(admin).unpause(), 'token.unpause');
    },
  },
  {
    id: '10',
    phase: 'C',
    title: 'Fund investors + allowances',
    desc: 'Test cash minted to each investor, who approve the DVD manager; B&D approves the bonds',
    signer: 'mixed',
    expectedTx: 7,
    run: async () => {
      const token = await at('Token', A().token);
      const cashToken = await at('MockCashToken', A().cashToken);
      for (const investor of INVESTORS) {
        const investorAddr = investorAddress(investor.label);
        const cashAmount = PRICE_PER_BOND.mul(investor.bonds);
        await once(`10:mint:${investor.label}`, () =>
          sendAndWait(() => cashToken.connect(admin).mint(investorAddr, cashAmount), `cashToken.mint(${investor.label})`),
        );
      }
      // One approval per distinct account. If several investors share one MetaMask account, approve the SUM once:
      // ERC-20 approve() overwrites the allowance, so separate approvals would leave the first swaps short.
      const byAccount = new Map<string, { labels: string[]; total: BigNumber }>();
      for (const investor of INVESTORS) {
        const key = investorAddress(investor.label).toLowerCase();
        const entry = byAccount.get(key) ?? { labels: [], total: BigNumber.from(0) };
        entry.labels.push(investor.label);
        entry.total = entry.total.add(PRICE_PER_BOND.mul(investor.bonds));
        byAccount.set(key, entry);
      }
      for (const [accountKey, { labels, total }] of byAccount) {
        const who = labels.join(' + ');
        await once(`10:approve:${accountKey}`, async () => {
          const approve = await cashToken.populateTransaction.approve(A().dvd, total);
          await investorSend(labels[0], `cashToken.approve(${who})`, approve, `Approve ${ethers.utils.formatUnits(total, 6)} EURd for the DVD manager (${who})`);
        });
      }
      await once('10:token-approve', () => sendAndWait(() => token.connect(admin).approve(A().dvd, SUPPLY_LIMIT), 'token.approve(dvd)'));
    },
  },
  swapStep(0),
  swapStep(1),
  swapStep(2),
];
const TOTAL_TX = STEPS.reduce((sum, s) => sum + s.expectedTx, 0);

/** Plain-language explanation shown in each step's "Details" panel. */
const DETAILS: Record<string, { why: string; what: string[]; signers: string }> = {
  '1': {
    why: 'Master copies that every deal\'s contracts are cloned from. They are never used directly, which keeps each deal cheap to create.',
    what: [
      'Token: the security token itself (ERC-3643)',
      'ClaimTopicsRegistry: which identity claims an investor must hold',
      'TrustedIssuersRegistry: who is allowed to issue those claims',
      'IdentityRegistryStorage: stores the wallet-to-identity mapping',
      'IdentityRegistry: checks whether a wallet is eligible to hold the token',
      'ModularCompliance: pluggable transfer rules',
    ],
    signers: 'Admin. 6 deployment transactions.',
  },
  '2': {
    why: 'The Implementation Authority is the registry of which implementation versions new deals should clone, and the single place to roll out upgrades.',
    what: ['Deploys TREXImplementationAuthority', 'Calls addAndUseTREXVersion to register version 1.0.0 pointing at the six implementations from step 1'],
    signers: 'Admin. 2 transactions.',
  },
  '3': {
    why: 'The factories are what actually build a deal. The ONCHAINID IdFactory is needed because TREXFactory creates an on-chain identity for each token.',
    what: [
      'Deploys the ONCHAINID Identity implementation and its ImplementationAuthority',
      'Deploys the IdFactory (creates on-chain identities)',
      'Deploys TREXFactory (builds the full contract suite for a deal)',
      'Calls idFactory.addTokenFactory so TREXFactory is allowed to create identities',
    ],
    signers: 'Admin. 5 transactions.',
  },
  '4': {
    why: 'The Gateway is the access-controlled front door: once it owns the factory, deals can only be created through it, and only by approved deployers.',
    what: [
      'Deploys TREXGateway (public deployments switched off)',
      'Transfers TREXFactory ownership to the gateway',
      'Adds the admin account as an approved deployer',
    ],
    signers: 'Admin. 3 transactions.',
  },
  '5': {
    why: 'A compliance module that caps total token supply. Behind a proxy so it can be upgraded, and shared by every deal.',
    what: [
      'Deploys the SupplyLimitModule implementation',
      'Deploys a ModuleProxy pointing at it and calls initialize in the same transaction',
      'The supply limit for this deal is set later, in step 7',
    ],
    signers: 'Admin. 2 transactions. Retrying reuses an implementation that already deployed.',
  },
  '6': {
    why: 'The settlement side of the demo: a test cash token to pay with and the engine that swaps bonds for cash atomically.',
    what: [
      'MockCashToken: test EURd with 6 decimals, admin can mint',
      'DVDTransferManager: holds both legs of a trade and settles them in a single transaction, so neither side can be left half-done',
    ],
    signers: 'Admin. 2 transactions.',
  },
  '7': {
    why: 'Creating a deal is a single call. The factory builds the whole contract suite for the bond.',
    what: [
      `Token: "${TOKEN_NAME}", symbol ${TOKEN_SYMBOL}, ${TOKEN_DECIMALS} decimals, owner = admin`,
      'Admin is both identity-registry agent (Registrar) and token agent (B&D)',
      `Compliance module: SupplyLimitModule with a limit of ${SUPPLY_LIMIT.toLocaleString()} bonds`,
      'No claim topics, so eligibility is decided purely by the whitelist',
      'Creates Token, IdentityRegistry, IdentityRegistryStorage, ClaimTopicsRegistry, TrustedIssuersRegistry and ModularCompliance',
      'The token address is read back from the factory using the deterministic salt (owner address + token name)',
    ],
    signers: 'Admin via the Gateway. 1 transaction.',
  },
  '8': {
    why: 'Only whitelisted wallets can hold or receive the bond. This is the Registrar step.',
    what: [
      'One batchRegisterIdentity call for 4 wallets: the admin (B&D) and the three investors',
      'Each wallet acts as its own identity, with country code 0',
    ],
    signers: 'Admin as Registrar. 1 transaction.',
  },
  '9': {
    why: 'Creates the bonds that will be sold. Tokens start paused, so trading is switched on here.',
    what: [`Mints ${SUPPLY_LIMIT.toLocaleString()} bonds (the full supply limit) to the admin acting as B&D`, 'Unpauses the token'],
    signers: 'Admin as B&D. 2 transactions.',
  },
  '10': {
    why: 'Gets cash and bonds approved for the DVD manager, so each swap can settle in one transaction.',
    what: [
      'Mints test EURd to each investor: bonds × 99.9 EURd (Aurora 199,800 · Northbridge 149,850 · Meridian 149,850)',
      'Each investor account approves the DVD manager to spend their cash (if one MetaMask account is shared, it approves the combined total once)',
      `Admin approves the DVD manager to move ${SUPPLY_LIMIT.toLocaleString()} bonds`,
    ],
    signers: 'Admin (4 txs, signed by the server) and the three investors (3 approvals, each confirmed in MetaMask). 7 transactions.',
  },
};
for (const [i, name, bonds] of [[0, 'Aurora', 2000], [1, 'Northbridge', 1500], [2, 'Meridian', 1500]] as const) {
  DETAILS[STEPS[10 + i].id] = {
    why: `Delivery-versus-payment: ${name} gets the bonds and the admin gets the cash in one atomic transaction, or neither moves.`,
    what: [
      `Admin (B&D) calls initiateDVDTransfer: offers ${bonds.toLocaleString()} bonds to ${name} for ${(bonds * 99.9).toLocaleString(undefined, { maximumFractionDigits: 1 })} EURd and receives a transfer ID`,
      `${name} calls takeDVDTransfer with that ID: bonds and cash swap atomically`,
    ],
    signers: `Admin (server), then ${name} confirming in MetaMask. 2 transactions.`,
  };
}

// ---------------------------------------------------------------------------
// State, snapshots, SSE
// ---------------------------------------------------------------------------
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Persisted;
    state = { addresses: saved.addresses || {}, steps: saved.steps || {}, txs: saved.txs || [], investors: saved.investors || {} };
    // a step that was mid-run when the server stopped did not complete
    for (const s of Object.values(state.steps)) if (s.status === 'running') s.status = 'pending';
  } catch {
    /* fresh start */
  }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const rt = (id: string): StepRuntime => (state.steps[id] ??= { status: 'pending', txDone: 0 });

let accounts: { label: string; address: string; balance: string; role: string }[] = [];
async function refreshAccounts() {
  if (!ready) return;
  const roles = [
    { label: 'Admin / Registrar / B&D', role: 'Admin', address: adminAddress },
    ...INVESTORS.filter((i) => state.investors[i.label]).map((i) => ({ label: i.label, role: 'Investor (MetaMask)', address: state.investors[i.label] })),
  ];
  accounts = await Promise.all(
    roles.map(async (r) => ({ ...r, balance: ethers.utils.formatEther(await ethers.provider.getBalance(r.address)) })),
  );
}

function snapshot() {
  const firstOpen = STEPS.find((s) => rt(s.id).status !== 'done')?.id;
  const steps = STEPS.map((s) => {
    const r = rt(s.id);
    return {
      id: s.id,
      phase: s.phase,
      title: s.title,
      desc: s.desc,
      details: DETAILS[s.id],
      signer: s.signer,
      expectedTx: s.expectedTx,
      status: r.status,
      txDone: r.txDone,
      durationMs: r.durationMs,
      startedAt: r.status === 'running' ? r.startedAt : undefined,
      error: r.error,
      canRetry: ready && !runningStep && !runningPhase && r.status === 'error',
    };
  });
  void firstOpen;
  const phases = (['A', 'B', 'C'] as const).map((p) => {
    const own = steps.filter((s) => s.phase === p);
    const started = own.some((s) => s.status !== 'pending');
    const hint = p === 'C' && !investorsAssigned() ? 'Assign the three investor MetaMask accounts first' : undefined;
    return { id: p, canRun: phaseCanRun(p), done: own.every((s) => s.status === 'done'), started, failed: own.some((s) => s.status === 'error'), hint };
  });
  const txDone = steps.reduce((sum, s) => sum + (s.status === 'done' ? s.expectedTx : Math.min(s.txDone, s.expectedTx)), 0);
  return {
    ready,
    initError,
    chainId: SEPOLIA_CHAIN_ID,
    explorer: EXPLORER,
    deal: { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, supply: SUPPLY_LIMIT },
    accounts,
    steps,
    phases,
    investors: INVESTORS.map((i) => ({ label: i.label, bonds: i.bonds, address: state.investors[i.label] })),
    investorsLocked: rt('8').status === 'done',
    adminAddress,
    pendingTx,
    addresses: state.addresses,
    txs: state.txs,
    totals: { txDone, txTotal: TOTAL_TX, stepsDone: steps.filter((s) => s.status === 'done').length, stepsTotal: steps.length },
    running: runningStep,
    runningPhase,
  };
}

const clients = new Set<http.ServerResponse>();
const logBuffer: { t: number; level: string; msg: string }[] = [];
function sse(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown) {
  for (const c of clients) sse(c, event, data);
}
const emit = () => broadcast('snapshot', snapshot());

for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    const entry = { t: Date.now(), level, msg: util.format(...args) };
    logBuffer.push(entry);
    if (logBuffer.length > 400) logBuffer.shift();
    broadcast('log', entry);
  };
}

// ---------------------------------------------------------------------------
// Running steps
// ---------------------------------------------------------------------------
async function runStep(id: string): Promise<boolean> {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`Unknown step ${id}`);
  if (!ready) throw new Error(initError || 'Server not ready');
  if (runningStep) throw new Error(`Step ${runningStep} is still running`);
  const firstOpen = STEPS.find((s) => rt(s.id).status !== 'done');
  if (firstOpen?.id !== id) throw new Error(`Run steps in order - next is step ${firstOpen?.id ?? 'none (all done)'}`);

  const r = rt(id);
  const started = Date.now();
  Object.assign(r, { status: 'running', txDone: 0, error: undefined, durationMs: undefined, startedAt: started });
  runningStep = id;
  txHooks.onMined = (label, hash, address) => {
    r.txDone += 1;
    state.txs.push({ step: id, label, hash });
    console.log(`  tx mined: ${label} ${address ? `@ ${address} ` : ''}(${hash})`);
    emit();
  };
  console.log(`\n=== Step ${id}: ${step.title} ===`);
  emit();
  try {
    await step.run();
    r.status = 'done';
    r.durationMs = Date.now() - started;
    console.log(`Step ${id} done in ${(r.durationMs / 1000).toFixed(1)}s`);
    return true;
  } catch (e) {
    r.status = 'error';
    r.error = e instanceof Error ? e.message : String(e);
    r.durationMs = Date.now() - started;
    console.error(`Step ${id} failed: ${r.error}`);
    return false;
  } finally {
    txHooks.onMined = undefined;
    runningStep = undefined;
    saveState();
    await refreshAccounts().catch(() => undefined);
    emit();
  }
}

/** Runs every unfinished step of one phase in order; stops at the first failure. */
async function runPhase(phase: string) {
  runningPhase = phase;
  emit();
  try {
    for (const s of STEPS.filter((x) => x.phase === phase)) {
      if (rt(s.id).status === 'done') continue;
      if (!(await runStep(s.id))) break;
    }
  } finally {
    runningPhase = undefined;
    emit();
  }
}

/** A phase can start when nothing is running, it is not finished, and all earlier phases are finished. */
function phaseCanRun(phase: string): boolean {
  if (!ready || runningStep || runningPhase) return false;
  const order = ['A', 'B', 'C'];
  const before = STEPS.filter((s) => order.indexOf(s.phase) < order.indexOf(phase));
  const own = STEPS.filter((s) => s.phase === phase);
  if (phase === 'C' && !investorsAssigned()) return false;
  return before.every((s) => rt(s.id).status === 'done') && own.some((s) => rt(s.id).status !== 'done');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== SEPOLIA_CHAIN_ID) {
      throw new Error(`Connected network has chain id ${chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}). Run with --network sepolia and set SEPOLIA_RPC_URL.`);
    }
    // Admin / Registrar / B&D is one account: the private key of your MetaMask (or any) account, from env.
    admin = new MinedNonceWallet(requireEnv('DEPLOYER_PRIVATE_KEY'), ethers.provider);
    adminAddress = admin.address;
    ready = true;
    await refreshAccounts();
    console.log(`Ready. Admin address: ${adminAddress}`);
  } catch (e) {
    initError = e instanceof Error ? e.message : String(e);
    console.error(`Init failed: ${initError}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return void res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      sse(res, 'snapshot', snapshot());
      sse(res, 'logs', logBuffer);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, snapshot());
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      await refreshAccounts();
      emit();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/step/')) {
      // Retry exactly one failed step (does not continue to the following steps).
      const id = decodeURIComponent(url.pathname.slice('/api/step/'.length));
      const step = STEPS.find((s) => s.id === id);
      if (!step) return json(res, 404, { error: `Unknown step ${id}` });
      if (!ready) return json(res, 409, { error: initError || 'Not ready' });
      if (runningStep || runningPhase) return json(res, 409, { error: 'Something is already running' });
      if (rt(id).status !== 'error') return json(res, 409, { error: `Step ${id} has not failed` });
      void runStep(id);
      return json(res, 202, { started: id });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/phase/')) {
      const phase = decodeURIComponent(url.pathname.slice('/api/phase/'.length));
      if (!['A', 'B', 'C'].includes(phase)) return json(res, 404, { error: `Unknown phase ${phase}` });
      if (!ready) return json(res, 409, { error: initError || 'Not ready' });
      if (runningStep || runningPhase) return json(res, 409, { error: 'A phase is already running' });
      if (!phaseCanRun(phase)) return json(res, 409, { error: `Phase ${phase} is complete or an earlier phase is not finished yet` });
      void runPhase(phase);
      return json(res, 202, { started: phase });
    }
    if (req.method === 'POST' && url.pathname === '/api/investor') {
      // Assign the connected MetaMask account to an investor
      const { label, address } = await readBody(req);
      if (!INVESTORS.some((i) => i.label === label)) return json(res, 404, { error: `Unknown investor ${label}` });
      if (!ethers.utils.isAddress(address)) return json(res, 400, { error: 'Not a valid address' });
      if (rt('8').status === 'done') return json(res, 409, { error: 'Investors are already whitelisted on chain; reset local progress to change them' });
      const checksummed = ethers.utils.getAddress(address);
      // Investors may share one MetaMask account, but it must differ from the admin account.
      if (adminAddress.toLowerCase() === checksummed.toLowerCase()) {
        return json(res, 409, { error: 'That is the admin account (DEPLOYER_PRIVATE_KEY). Pick a different MetaMask account for investors.' });
      }
      state.investors[label] = checksummed;
      saveState();
      console.log(`Assigned ${checksummed} to investor ${label}`);
      await refreshAccounts();
      emit();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/investor-tx/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/investor-tx/'.length));
      if (!pendingSettle || pendingSettle.id !== id) return json(res, 404, { error: 'No such pending transaction' });
      const { hash, error } = await readBody(req);
      if (hash) pendingSettle.resolve(hash);
      else pendingSettle.reject(new Error(error || 'Rejected in MetaMask'));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      if (runningStep) return json(res, 409, { error: 'Cannot reset while a step is running' });
      state = { addresses: {}, steps: {}, txs: [], investors: state.investors };
      saveState();
      console.log('Local progress reset (contracts already deployed on Sepolia are not affected).');
      emit();
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

async function main() {
  loadState();
  await init();
  server.listen(PORT, '127.0.0.1', () => console.log(`\nDemo UI running at http://127.0.0.1:${PORT}  (Ctrl+C to stop)\n`));
  await new Promise(() => undefined); // keep `hardhat run` alive
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
