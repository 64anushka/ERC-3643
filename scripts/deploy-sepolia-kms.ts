import { ethers } from 'hardhat';
import { BigNumber, Event } from 'ethers';
import OnchainID from '@onchain-id/solidity';
import { AwsKmsSigner } from './signers/aws-kms-signer';
import { deployAndWait, deployArtifactAndWait, MinedNonceWallet, sendAndWait, StepTimer } from './lib/tx-helpers';

/**
 * Sepolia variant of scripts/deploy-sepolia.ts where Platform Admin, Registrar and B&D
 * are ONE account whose key lives in AWS KMS (the private key never leaves KMS). The
 * three example investors still sign with plain private keys from env, since they have
 * to approve the cash and take their own DVD trades.
 *
 * Same Phase A/B/C flow as the other scripts; every step is timed and a summary table
 * is printed at the end.
 *
 * Required env vars (see .env.example):
 *   SEPOLIA_RPC_URL           - read by hardhat.config.ts
 *   KMS_KEY_ID                - AWS KMS key id or ARN (asymmetric, ECC_SECG_P256K1)
 *   AWS_REGION                - optional, falls back to the default AWS SDK region chain
 *   AURORA_PRIVATE_KEY, NORTHBRIDGE_PRIVATE_KEY, MERIDIAN_PRIVATE_KEY - the 3 example investors
 *
 * AWS credentials come from the default AWS SDK credential chain and need kms:GetPublicKey
 * and kms:Sign on KMS_KEY_ID. The KMS address and the investors need Sepolia ETH for gas.
 *
 * Run with: npx hardhat run scripts/deploy-sepolia-kms.ts --network sepolia
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

  // One KMS-backed account plays Platform Admin, Registrar and B&D.
  const admin = new AwsKmsSigner(requireEnv('KMS_KEY_ID'), ethers.provider, process.env.AWS_REGION);
  const adminAddress = await admin.getAddress();

  const aurora = new MinedNonceWallet(requireEnv('AURORA_PRIVATE_KEY'), ethers.provider);
  const northbridge = new MinedNonceWallet(requireEnv('NORTHBRIDGE_PRIVATE_KEY'), ethers.provider);
  const meridian = new MinedNonceWallet(requireEnv('MERIDIAN_PRIVATE_KEY'), ethers.provider);
  const investors = [
    { label: 'Aurora', wallet: aurora, bonds: 2000 },
    { label: 'Northbridge', wallet: northbridge, bonds: 1500 },
    { label: 'Meridian', wallet: meridian, bonds: 1500 },
  ];

  // The admin account and the investors are all whitelisted, and an identity can only be registered once.
  const whitelisted = new Set([adminAddress, ...investors.map((i) => i.wallet.address)]);
  if (whitelisted.size !== 4) {
    throw new Error('The KMS key address and the AURORA / NORTHBRIDGE / MERIDIAN private keys must all be different accounts.');
  }

  console.log('=== Accounts ===');
  const roles = [{ label: 'Admin/Registrar/B&D (KMS)', wallet: { address: adminAddress } }, ...investors];
  for (const role of roles) {
    const balance = await ethers.provider.getBalance(role.wallet.address);
    console.log(
      `${role.label.padEnd(26)} ${role.wallet.address}  ${ethers.utils.formatEther(balance)} ETH  ${EXPLORER_BASE_URL}${role.wallet.address}`,
    );
    if (balance.isZero()) {
      console.warn(`  WARNING: ${role.label} has no Sepolia ETH for gas - fund it before this account needs to send a transaction.`);
    }
  }

  const timer = new StepTimer();

  // ---------------------------------------------------------------------
  // PHASE A: platform setup (deploy once, shared by all deals)
  // ---------------------------------------------------------------------
  console.log('\n=== Phase A: platform setup ===');
  timer.phase('Phase A: platform setup');

  // Step 1: implementation contracts (master copies, never used directly)
  const { tokenImplementation, ctrImplementation, tirImplementation, irsImplementation, irImplementation, mcImplementation } = await timer.run(
    'Step 1: deploy 6 implementation contracts',
    async () => ({
      tokenImplementation: await deployAndWait('Token', [], admin),
      ctrImplementation: await deployAndWait('ClaimTopicsRegistry', [], admin),
      tirImplementation: await deployAndWait('TrustedIssuersRegistry', [], admin),
      irsImplementation: await deployAndWait('IdentityRegistryStorage', [], admin),
      irImplementation: await deployAndWait('IdentityRegistry', [], admin),
      mcImplementation: await deployAndWait('ModularCompliance', [], admin),
    }),
  );
  console.log('Step 1: implementations deployed');

  // Step 2: TREXImplementationAuthority, registered as version 1.0.0
  const ia = await timer.run('Step 2: TREXImplementationAuthority + version', async () => {
    const authority = await deployAndWait(
      'TREXImplementationAuthority',
      [true, ethers.constants.AddressZero, ethers.constants.AddressZero],
      admin,
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
    await sendAndWait(() => authority.connect(admin).addAndUseTREXVersion(version, implementations), 'addAndUseTREXVersion');
    return authority;
  });
  console.log('Step 2: TREXImplementationAuthority deployed at', ia.address);

  // Step 3: ONCHAINID IdFactory + TREXFactory (original TREXFactory needs an IdFactory to create the token's identity)
  const { idFactory, factory } = await timer.run('Step 3: ONCHAINID IdFactory + TREXFactory', async () => {
    const identityImplementation = await deployArtifactAndWait(OnchainID.contracts.Identity, [adminAddress, true], admin, 'Identity');
    const identityIa = await deployArtifactAndWait(
      OnchainID.contracts.ImplementationAuthority,
      [identityImplementation.address],
      admin,
      'ONCHAINID ImplementationAuthority',
    );
    const identityFactory = await deployArtifactAndWait(OnchainID.contracts.Factory, [identityIa.address], admin, 'IdFactory');
    const trexFactory = await deployAndWait('TREXFactory', [ia.address, identityFactory.address], admin);
    await sendAndWait(() => identityFactory.connect(admin).addTokenFactory(trexFactory.address), 'idFactory.addTokenFactory');
    return { idFactory: identityFactory, factory: trexFactory };
  });
  console.log('Step 3: IdFactory deployed at', idFactory.address);
  console.log('Step 3: TREXFactory deployed at', factory.address);

  // Step 4: TREXGateway - front door, access controlled
  const gateway = await timer.run('Step 4: TREXGateway + ownership + deployer', async () => {
    const trexGateway = await deployAndWait('TREXGateway', [factory.address, false], admin);
    await sendAndWait(() => factory.connect(admin).transferOwnership(trexGateway.address), 'factory.transferOwnership');
    await sendAndWait(() => trexGateway.connect(admin).addDeployer(adminAddress), 'gateway.addDeployer');
    return trexGateway;
  });
  console.log('Step 4: TREXGateway deployed at', gateway.address);

  // Step 5: SupplyLimitModule behind an upgradeable ModuleProxy, shared across deals
  const supplyLimitModule = await timer.run('Step 5: SupplyLimitModule + ModuleProxy', async () => {
    const implementation = await deployAndWait('SupplyLimitModule', [], admin);
    const initData = implementation.interface.encodeFunctionData('initialize');
    const proxy = await deployAndWait('ModuleProxy', [implementation.address, initData], admin);
    return ethers.getContractAt('SupplyLimitModule', proxy.address);
  });
  console.log('Step 5: SupplyLimitModule proxy deployed at', supplyLimitModule.address);

  // Step 6: MockCashToken (test EURd) + DVDTransferManager (atomic swap engine)
  const { cashToken, dvd } = await timer.run('Step 6: MockCashToken + DVDTransferManager', async () => ({
    cashToken: await deployAndWait('MockCashToken', [adminAddress], admin),
    dvd: await deployAndWait('DVDTransferManager', [], admin),
  }));
  console.log('Step 6: MockCashToken deployed at', cashToken.address);
  console.log('Step 6: DVDTransferManager deployed at', dvd.address);

  // ---------------------------------------------------------------------
  // PHASE B: create a deal (one transaction)
  // ---------------------------------------------------------------------
  console.log('\n=== Phase B: create a deal ===');
  timer.phase('Phase B: create a deal');

  const tokenDetails = {
    owner: adminAddress,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    decimals: TOKEN_DECIMALS,
    irs: ethers.constants.AddressZero, // deploy a new IdentityRegistryStorage
    ONCHAINID: ethers.constants.AddressZero, // factory creates the token's identity through the IdFactory
    irAgents: [adminAddress],
    tokenAgents: [adminAddress],
    complianceModules: [supplyLimitModule.address],
    complianceSettings: [supplyLimitModule.interface.encodeFunctionData('setSupplyLimit', [SUPPLY_LIMIT])],
  };
  const claimDetails = { claimTopics: [], issuers: [], issuerClaims: [] };

  // Step 7: Platform Admin deploys the full 6-contract suite through the Gateway
  const { token, identityRegistry, compliance } = await timer.run('Step 7: gateway.deployTREXSuite', async () => {
    await sendAndWait(() => gateway.connect(admin).deployTREXSuite(tokenDetails, claimDetails), 'deployTREXSuite');

    // Gateway derives the CREATE2 salt as hex(owner) + tokenName (see TREXGateway.sol)
    const salt = `${adminAddress.toLowerCase()}${TOKEN_NAME}`;
    const tokenAddress = await factory.getToken(salt);
    const deployedToken = await ethers.getContractAt('Token', tokenAddress);
    return {
      token: deployedToken,
      identityRegistry: await ethers.getContractAt('IdentityRegistry', await deployedToken.identityRegistry()),
      compliance: await ethers.getContractAt('ModularCompliance', await deployedToken.compliance()),
    };
  });
  console.log('Step 7: deal deployed - token at', token.address);
  console.log('         identityRegistry at', identityRegistry.address);
  console.log('         compliance at', compliance.address);

  // ---------------------------------------------------------------------
  // PHASE C: run the deal (settlement)
  // ---------------------------------------------------------------------
  console.log('\n=== Phase C: run the deal ===');
  timer.phase('Phase C: run the deal');

  // Step 8: Registrar writes the whitelist (each wallet is its own "identity")
  const wallets = [adminAddress, ...investors.map((i) => i.wallet.address)];
  await timer.run('Step 8: whitelist wallets', () =>
    sendAndWait(
      () =>
        identityRegistry.connect(admin).batchRegisterIdentity(
          wallets,
          wallets,
          wallets.map(() => 0),
        ),
      'batchRegisterIdentity',
    ),
  );
  console.log('Step 8: whitelisted', wallets.length, 'wallets');

  // Step 9: B&D mints the full supply to itself and unpauses the token
  await timer.run('Step 9: mint supply + unpause', async () => {
    await sendAndWait(() => token.connect(admin).mint(adminAddress, SUPPLY_LIMIT), 'token.mint');
    await sendAndWait(() => token.connect(admin).unpause(), 'token.unpause');
  });
  console.log('Step 9: minted', SUPPLY_LIMIT, 'bonds to B&D and unpaused the token');

  // Step 10: fund investors with test cash, set allowances both ways
  await timer.run('Step 10: fund investors + allowances', async () => {
    for (const investor of investors) {
      const cashAmount = PRICE_PER_BOND.mul(investor.bonds);
      await sendAndWait(() => cashToken.connect(admin).mint(investor.wallet.address, cashAmount), `cashToken.mint(${investor.label})`);
      await sendAndWait(() => cashToken.connect(investor.wallet).approve(dvd.address, cashAmount), `cashToken.approve(${investor.label})`);
    }
    await sendAndWait(() => token.connect(admin).approve(dvd.address, SUPPLY_LIMIT), 'token.approve(dvd)');
  });
  console.log('Step 10: funded investors and set DVD allowances');

  // Steps 11-12: B&D offers each trade, investor accepts - atomic swap
  for (const investor of investors) {
    const cashAmount = PRICE_PER_BOND.mul(investor.bonds);
    await timer.run(`Step 11-12: DVD swap with ${investor.label}`, async () => {
      const initiateReceipt = await sendAndWait(
        () => dvd.connect(admin).initiateDVDTransfer(token.address, investor.bonds, investor.wallet.address, cashToken.address, cashAmount),
        `initiateDVDTransfer(${investor.label})`,
      );
      const initiatedEvent = initiateReceipt.events?.find((e: Event) => e.event === 'DVDTransferInitiated');
      const transferID = initiatedEvent?.args?.transferID as string;

      await sendAndWait(() => dvd.connect(investor.wallet).takeDVDTransfer(transferID), `takeDVDTransfer(${investor.label})`);
    });
    console.log(
      `Step 11-12: settled ${investor.bonds} bonds <-> ${ethers.utils.formatUnits(cashAmount, 6)} EURd with ${investor.label} (${investor.wallet.address})`,
    );
  }

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  console.log('\n=== Deployment summary ===');
  const summary = {
    adminRegistrarBnd: adminAddress,
    implementationAuthority: ia.address,
    idFactory: idFactory.address,
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

  timer.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
