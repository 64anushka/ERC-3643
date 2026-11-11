import { ethers } from 'hardhat';
import { BigNumber, Event } from 'ethers';
import OnchainID from '@onchain-id/solidity';
import { deployAndWait, deployArtifactAndWait, sendAndWait } from './lib/tx-helpers';

/**
 * Deploys the SCO Bond ERC-3643 stack (original TREXFactory with an ONCHAINID IdFactory; investors are whitelisted with their wallet as identity, no claims) and
 * runs one example deal end to end, following SCO_Bond_ERC3643_Deployment_Guide.md:
 *   Phase A - platform setup (deploy once)
 *   Phase B - create a deal (one gateway.deployTREXSuite call)
 *   Phase C - run the deal (whitelist, mint, fund, DVD swaps)
 *
 * Run with: npx hardhat run scripts/deploy.ts --network <network>
 */

// ---------------------------------------------------------------------------
// Deal configuration - edit per issuance
// ---------------------------------------------------------------------------
const TOKEN_NAME = 'ACME Corp / 3.875% Fixed EMTN';
const TOKEN_SYMBOL = 'TR-51X5RT-01';
const TOKEN_DECIMALS = 0;
const SUPPLY_LIMIT = 5000;
const PRICE_PER_BOND = BigNumber.from(99_900_000); // 99.9 EURd (6 decimals) per bond

async function main() {
  const [deployer, registrar, bnd, aurora, northbridge, meridian] = await ethers.getSigners();
  const platformAdmin = deployer;

  const investors = [
    { label: 'Aurora', wallet: aurora, bonds: 2000 },
    { label: 'Northbridge', wallet: northbridge, bonds: 1500 },
    { label: 'Meridian', wallet: meridian, bonds: 1500 },
  ];

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
  console.log(
    JSON.stringify(
      {
        implementationAuthority: ia.address,
        factory: factory.address,
        gateway: gateway.address,
        supplyLimitModule: supplyLimitModule.address,
        cashToken: cashToken.address,
        dvd: dvd.address,
        token: token.address,
        identityRegistry: identityRegistry.address,
        compliance: compliance.address,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
