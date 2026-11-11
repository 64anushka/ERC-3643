# bond-backend

Spring Boot 3 / Java 17 REST API that runs the SCO bond flow of `scripts/deploy-sepolia-kms.ts`
(Platform Admin = Registrar = B&D = one AWS KMS key). Swagger UI: http://localhost:8080/swagger-ui.html

| API | Script steps |
|---|---|
| `POST /api/deployments` | Steps 1-8 (platform, deal, whitelist) + funds the whitelisted wallets with EURd. Runs in the background, returns a `jobId`; poll `GET /api/deployments/jobs/{jobId}`. |
| `POST /api/bonds/mint` | Step 9: mints bonds to the B&D wallet, unpauses the token, approves the DVD manager. |
| `POST /api/settlements` | Steps 10-12 for one whitelisted investor: cash approval, `initiateDVDTransfer`, `takeDVDTransfer`. |
| `GET /api/deployments/current` | Addresses of the latest deployment. |

## Prerequisites
- JDK 17, Maven 3.9+
- Contracts compiled in `T-REX` (`npx hardhat compile`) - the backend reads bytecode from `../artifacts` and `../node_modules/@onchain-id/solidity/artifacts`.
- KMS key (ECC_SECG_P256K1) with AWS credentials in the default SDK chain; its address needs Sepolia ETH.
- Investor wallets that will settle need Sepolia ETH and their private key configured (they sign the cash approval and `takeDVDTransfer`).

## Configuration
Read from environment variables or `T-REX/.env` (same names as the hardhat scripts):
`SEPOLIA_RPC_URL`, `KMS_KEY_ID`, `AWS_REGION`, `AURORA_PRIVATE_KEY`, `NORTHBRIDGE_PRIVATE_KEY`, `MERIDIAN_PRIVATE_KEY`,
optionally `EXTRA_INVESTOR_PRIVATE_KEY`. Deal defaults (token name, supply limit, price, funding) are in `application.yml`
and can be overridden per request in the deployment body.

For a local hardhat node: `SIGNER_TYPE=private-key ADMIN_PRIVATE_KEY=<key> SEPOLIA_RPC_URL=http://127.0.0.1:8545`.

## Run
```
cd T-REX/backend
mvn spring-boot:run
```

## Typical sequence
1. `POST /api/deployments` `{"whitelistAddresses": ["0x...", "0x..."]}` then poll the job until `SUCCEEDED`.
2. `POST /api/bonds/mint` `{}` (full supply) or `{"amount": 3000}`.
3. `POST /api/settlements` `{"investorAddress": "0x...", "bonds": 2000}`.

Only one operation runs at a time (HTTP 409 otherwise) because they all send from the same admin account.
A deal name can be deployed only once per factory (CREATE2 salt), but each deployment creates a new factory, so redeploying is fine.
The latest deployment is saved to `deployment-state.json` (git-ignored).
