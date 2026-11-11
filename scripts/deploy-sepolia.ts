import { ethers } from 'hardhat';
import { BigNumber, Event } from 'ethers';
import OnchainID from '@onchain-id/solidity';
import { deployAndWait, deployArtifactAndWait, MinedNonceWallet, sendAndWait } from './lib/tx-helpers';

/**
 * Sepolia testnet variant of scripts/deploy.ts - same Phase A/B/C flow from
 * SCO_Bond_ERC3643_Deployment_Guide.md, but every role is a real funded
 * Sepolia account (private key from env) instead of a Hardhat auto-generated
 * signer, since those only exist on the local in-memory network.
 *
 * Required env vars (see .env.example) - all 6 accounts need Sepolia ETH
 * for gas; the investors' EURd is minted by this script, no funding needed:
 *   DEPLOYER_PRIVATE_KEY      - Platform Admin
 *   REGISTRAR_PRIVATE_KEY     - Registrar (IdentityRegistry agent)
 *   BND_PRIVATE_KEY           - B&D (Token agent)
 *   AURORA_PRIVATE_KEY
 *   NORTHBRIDGE_PRIVATE_KEY
 *   MERIDIAN_PRIVATE_KEY      - the 3 example investors
 *
 * Run with: npx hardhat run scripts/deploy-sepolia.ts --network sepolia
 */

const SEPOLIA_CHAIN_ID = 11155111;
const EXPLORER_BASE_URL = 'https://sepolia.etherscan.io/address/';

// ---------------------------------------------------------------------------
// Deal configuration - edit per issuance
// ---------------------------------------------------------------------------
const TOKEN_NAME = 'ACME Corp / 3.875% Fixed EMTN';
const TOKEN_SYMBOL = 'TR-51X5RT-01';
const TOKEN_DECIMALS = 0;
const SUPPLY_LIMIT = 5000;
const PRICE_PER_BOND = BigNumber.from(99_900_000); // 99.9 EURd (6 decimals) per bond

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `This script is wired for Sepolia (chain id ${SEPOLIA_CHAIN_ID}) but the connected network reports chain id ${chainId}. ` +
        'Run it with --network sepolia.',
    );
  }

  const platformAdmin = new MinedNonceWallet(requireEnv('DEPLOYER_PRIVATE_KEY'), ethers.provider);
  const registrar = new MinedNonceWallet(requireEnv('REGISTRAR_PRIVATE_KEY'), ethers.provider);
  const bnd = new MinedNonceWallet(requireEnv('BND_PRIVATE_KEY'), ethers.provider);
  const aurora = new MinedNonceWallet(requireEnv('AURORA_PRIVATE_KEY'), ethers.provider);
  const northbridge = new MinedNonceWallet(requireEnv('NORTHBRIDGE_PRIVATE_KEY'), ethers.provider);
  const meridian = new MinedNonceWallet(requireEnv('MERIDIAN_PRIVATE_KEY'), ethers.provider);

  const investors = [
    { label: 'Aurora', wallet: aurora, bonds: 2000 },
    { label: 'Northbridge', wallet: northbridge, bonds: 1500 },
    { label: 'Meridian', wallet: meridian, bonds: 1500 },
  ];

  // Platform Admin / Registrar / B&D may be the same account, but every whitelisted wallet
  // (B&D + the 3 investors) must be unique - an identity can only be registered once.
  const whitelisted = new Set([bnd, aurora, northbridge, meridian].map((w) => w.address));
  if (whitelisted.size !== 4) {
    throw new Error('BND, AURORA, NORTHBRIDGE and MERIDIAN private keys must all be different accounts.');
  }

  console.log('=== Accounts ===');
  const roles = [
    { label: 'Platform Admin', wallet: platformAdmin },
    { label: 'Registrar', wallet: registrar },
    { label: 'B&D', wallet: bnd },
    ...investors,
  ];
  for (const role of roles) {
    const balance = await ethers.provider.getBalance(role.wallet.address);
    console.log(
      `${role.label.padEnd(14)} ${role.wallet.address}  ${ethers.utils.formatEther(balance)} ETH  ${EXPLORER_BASE_URL}${role.wallet.address}`,
    );
    if (balance.isZero()) {
      console.warn(`  WARNING: ${role.label} has no Sepolia ETH for gas - fund it before this account needs to send a transaction.`);
    }
  }

  // ---------------------------------------------------------------------
  // PHASE A: platform setup (deploy once, shared by all deals)
  // ---------------------------------------------------------------------
  console.log('\n=== Phase A: platform setup ===');

  // Step 1: implementation contracts (master copies, never used directly)
  const tokenImplementation = await deployAndWait('Token', [], platformAdmin);
  const ctrImplementation = await deployAndWait('ClaimTopicsRegistry', [], platformAdmin);
  const tirImplementation = await deployAndWait('TrustedIssuersRegistry', [], platformAdmin);
  const irsImplementation = await deployAndWait('IdentityRegistryStorage', [], platformAdmin);
  const irImplementation = await deployAndWait('IdentityRegistry', [], platformAdmin);
  const mcImplementation = await deployAndWait('ModularCompliance', [], platformAdmin);
  console.log('Step 1: implementations deployed');

  // Step 2: TREXImplementationAuthority, registered as version 1.0.0
  const ia = await deployAndWait(
    'TREXImplementationAuthority',
    [true, ethers.constants.AddressZero, ethers.constants.AddressZero],
    platformAdmin,
  );
  const version = { major: 1, minor: 0, patch: 0 };
  const implementations = {
    tokenImplementation: tokenImplementation.address,
    ctrImplementation: ctrImplementation.address,
    irImplementation: irImplementation.address,
    irsImplementation: irsImplementation.address,
    tirImplementation: tirImplementation.address,
    mcImplementation: mcImplementation.address,
  };
  await sendAndWait(() => ia.connect(platformAdmin).addAndUseTREXVersion(version, implementations), 'addAndUseTREXVersion');
  console.log('Step 2: TREXImplementationAuthority deployed at', ia.address);

  // Step 3: ONCHAINID IdFactory (the original TREXFactory needs one to create the token's identity)
  const identityImplementation = await deployArtifactAndWait(OnchainID.contracts.Identity, [platformAdmin.address, true], platformAdmin, 'Identity');
  const identityIa = await deployArtifactAndWait(
    OnchainID.contracts.ImplementationAuthority,
    [identityImplementation.address],
    platformAdmin,
    'ONCHAINID ImplementationAuthority',
  );
  const idFactory = await deployArtifactAndWait(OnchainID.contracts.Factory, [identityIa.address], platformAdmin, 'IdFactory');
  console.log('Step 3a: ONCHAINID IdFactory deployed at', idFactory.address);

  // Step 3b: TREXFactory (original upstream version - constructor takes the IA and the IdFactory)
  const factory = await deployAndWait('TREXFactory', [ia.address, idFactory.address], platformAdmin);
  await sendAndWait(() => idFactory.connect(platformAdmin).addTokenFactory(factory.address), 'idFactory.addTokenFactory');
  console.log('Step 3b: TREXFactory deployed at', factory.address);

  // Step 4: TREXGateway - front door, access controlled
  const gateway = await deployAndWait('TREXGateway', [factory.address, false], platformAdmin);
  await sendAndWait(() => factory.connect(platformAdmin).transferOwnership(gateway.address), 'factory.transferOwnership');
  await sendAndWait(() => gateway.connect(platformAdmin).addDeployer(platformAdmin.address), 'gateway.addDeployer');
  console.log('Step 4: TREXGateway deployed at', gateway.address);

  // Step 5: SupplyLimitModule behind an upgradeable ModuleProxy, shared across deals
  const supplyLimitImplementation = await deployAndWait('SupplyLimitModule', [], platformAdmin);
  const initData = supplyLimitImplementation.interface.encodeFunctionData('initialize');
  const supplyLimitProxy = await deployAndWait(
    'ModuleProxy',
    [supplyLimitImplementation.address, initData],
    platformAdmin,
  );
  const supplyLimitModule = await ethers.getContractAt('SupplyLimitModule', supplyLimitProxy.address);
  console.log('Step 5: SupplyLimitModule proxy deployed at', supplyLimitModule.address);

  // Step 6: MockCashToken (test EURd) + DVDTransferManager (atomic swap engine)
  const cashToken = await deployAndWait('MockCashToken', [platformAdmin.address], platformAdmin);
  const dvd = await deployAndWait('DVDTransferManager', [], platformAdmin);
  console.log('Step 6: MockCashToken deployed at', cashToken.address);
  console.log('Step 6: DVDTransferManager deployed at', dvd.address);
//-----------------------------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // PHASE B: create a deal (one transaction)
  // ---------------------------------------------------------------------
  console.log('\n=== Phase B: create a deal ===');

  const tokenDetails = {
    owner: platformAdmin.address,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    decimals: TOKEN_DECIMALS,
    irs: ethers.constants.AddressZero, // deploy a new IdentityRegistryStorage
    ONCHAINID: ethers.constants.AddressZero, // factory creates the token's identity through the IdFactory
    irAgents: [registrar.address],
    tokenAgents: [bnd.address],
    complianceModules: [supplyLimitModule.address],
    complianceSettings: [supplyLimitModule.interface.encodeFunctionData('setSupplyLimit', [SUPPLY_LIMIT])],
  };
  const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };

  // Step 7: Platform Admin deploys the full 6-contract suite through the Gateway
  await sendAndWait(() => gateway.connect(platformAdmin).deployTREXSuite(tokenDetails, claimDetails), 'deployTREXSuite');

  // Gateway derives the CREATE2 salt as hex(owner) + tokenName (see TREXGateway.sol)
  const salt = `${platformAdmin.address.toLowerCase()}${TOKEN_NAME}`;
  const tokenAddress = await factory.getToken(salt);
  const token = await ethers.getContractAt('Token', tokenAddress);
  const identityRegistry = await ethers.getContractAt('IdentityRegistry', await token.identityRegistry());
  const compliance = await ethers.getContractAt('ModularCompliance', await token.compliance());

  console.log('Step 7: deal deployed - token at', token.address);
  console.log('         identityRegistry at', identityRegistry.address);
  console.log('         compliance at', compliance.address);

  // ---------------------------------------------------------------------
  // PHASE C: run the deal (settlement)
  // ---------------------------------------------------------------------
  console.log('\n=== Phase C: run the deal ===');

  // Step 8: Registrar writes the whitelist (each wallet is its own "identity")
  const wallets = [bnd.address, ...investors.map((i) => i.wallet.address)];
  await sendAndWait(
    () =>
      identityRegistry.connect(registrar).batchRegisterIdentity(
        wallets,
        wallets,
        wallets.map(() => 0),
      ),
    'batchRegisterIdentity',
  );
  console.log('Step 8: whitelisted', wallets.length, 'wallets');

  // Step 9: B&D mints the full supply to itself and unpauses the token
  await sendAndWait(() => token.connect(bnd).mint(bnd.address, SUPPLY_LIMIT), 'token.mint');
  await sendAndWait(() => token.connect(bnd).unpause(), 'token.unpause');
  console.log('Step 9: minted', SUPPLY_LIMIT, 'bonds to B&D and unpaused the token');

  // Step 10: fund investors with test cash, set allowances both ways
  for (const investor of investors) {
    const cashAmount = PRICE_PER_BOND.mul(investor.bonds);
    await sendAndWait(() => cashToken.connect(platformAdmin).mint(investor.wallet.address, cashAmount), `cashToken.mint(${investor.label})`);
    await sendAndWait(() => cashToken.connect(investor.wallet).approve(dvd.address, cashAmount), `cashToken.approve(${investor.label})`);
  }
  await sendAndWait(() => token.connect(bnd).approve(dvd.address, SUPPLY_LIMIT), 'token.approve(dvd)');
  console.log('Step 10: funded investors and set DVD allowances');

  // Steps 11-12: B&D offers each trade, investor accepts - atomic swap
  for (const investor of investors) {
    const cashAmount = PRICE_PER_BOND.mul(investor.bonds);

    const initiateReceipt = await sendAndWait(
      () => dvd.connect(bnd).initiateDVDTransfer(token.address, investor.bonds, investor.wallet.address, cashToken.address, cashAmount),
      `initiateDVDTransfer(${investor.label})`,
    );
    const initiatedEvent = initiateReceipt.events?.find((e: Event) => e.event === 'DVDTransferInitiated');
    const transferID = initiatedEvent?.args?.transferID as string;

    await sendAndWait(() => dvd.connect(investor.wallet).takeDVDTransfer(transferID), `takeDVDTransfer(${investor.label})`);

    console.log(
      `Step 11-12: settled ${investor.bonds} bonds <-> ${ethers.utils.formatUnits(cashAmount, 6)} EURd with ${investor.label} (${investor.wallet.address})`,
    );
  }

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  console.log('\n=== Deployment summary ===');
  const summary = {
    implementationAuthority: ia.address,
    factory: factory.address,
    gateway: gateway.address,
    supplyLimitModule: supplyLimitModule.address,
    cashToken: cashToken.address,
    dvd: dvd.address,
    token: token.address,
    identityRegistry: identityRegistry.address,
    compliance: compliance.address,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nEtherscan:');
  for (const [label, address] of Object.entries(summary)) {
    console.log(`  ${label}: ${EXPLORER_BASE_URL}${address}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
