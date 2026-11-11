import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { BigNumber, Signer, utils } from 'ethers';
import { BlockTag, Provider, TransactionRequest, TransactionResponse } from '@ethersproject/abstract-provider';
import { Deferrable, resolveProperties } from '@ethersproject/properties';
import { serialize, UnsignedTransaction } from '@ethersproject/transactions';

// secp256k1 curve order, and its half, used to normalize signatures to "low-S"
// form - Ethereum (unlike plain ECDSA) rejects the high-S variant.
const SECP256K1_N = BigNumber.from('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_HALF_N = SECP256K1_N.div(2);

function toPaddedHex(buf: Buffer): string {
  return '0x' + stripLeadingZeros(buf).toString('hex').padStart(64, '0');
}

function stripLeadingZeros(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  return buf.subarray(start);
}

/** Reads a DER length field (short or long form) starting at `offset`. */
function readDerLength(der: Buffer, offset: number): { length: number; offset: number } {
  const first = der[offset++];
  if ((first & 0x80) === 0) {
    return { length: first, offset };
  }
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | der[offset++];
  }
  return { length, offset };
}

/**
 * Minimal DER parser for the ECDSA-Sig-Value ASN.1 structure
 * (SEQUENCE { r INTEGER, s INTEGER }) returned by KMS's Sign operation.
 */
function parseDerSignature(der: Buffer): { r: Buffer; s: Buffer } {
  let offset = 0;
  if (der[offset++] !== 0x30) {
    throw new Error('Invalid DER signature: expected SEQUENCE');
  }
  ({ offset } = readDerLength(der, offset));

  if (der[offset++] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER (r)');
  }
  let rLen: number;
  ({ length: rLen, offset } = readDerLength(der, offset));
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;

  if (der[offset++] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER (s)');
  }
  let sLen: number;
  ({ length: sLen, offset } = readDerLength(der, offset));
  const s = der.subarray(offset, offset + sLen);

  return { r: Buffer.from(r), s: Buffer.from(s) };
}

/**
 * Extracts the uncompressed secp256k1 public key point (0x04 || X || Y, 65
 * bytes) from the DER-encoded SubjectPublicKeyInfo that KMS's GetPublicKey
 * returns. The BIT STRING content for an EC key is always the raw point
 * preceded by a single "unused bits" byte (0x00), so the point is reliably
 * the last 65 bytes of the structure.
 */
function extractUncompressedPublicKey(spki: Buffer): Buffer {
  const point = spki.subarray(spki.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('Unexpected public key format returned by KMS - is this an ECC_SECG_P256K1 key?');
  }
  return Buffer.from(point);
}

/**
 * An ethers v5 Signer that delegates signing to an asymmetric ECC_SECG_P256K1
 * key held in AWS KMS. The private key material never leaves KMS; this class
 * only ever sees digests and DER signatures.
 *
 * Requires the caller's AWS credentials (env vars, shared config, instance
 * role, etc. - resolved by the default AWS SDK credential chain) to have
 * kms:GetPublicKey and kms:Sign on the given key.
 */
export class AwsKmsSigner extends Signer {
  readonly keyId: string;
  private readonly kms: KMSClient;
  private readonly region?: string;
  private nextNonce = 0;
  private addressPromise?: Promise<string>;
  private publicKeyPromise?: Promise<Buffer>;

  constructor(keyId: string, provider?: Provider, region?: string) {
    super();
    this.keyId = keyId;
    this.region = region;
    this.kms = new KMSClient({ region });
    if (provider) {
      utils.defineReadOnly(this, 'provider', provider);
    }
  }

  connect(provider: Provider): AwsKmsSigner {
    return new AwsKmsSigner(this.keyId, provider, this.region);
  }

  async getAddress(): Promise<string> {
    if (!this.addressPromise) {
      this.addressPromise = this.getPublicKey().then((publicKey) => utils.computeAddress(publicKey));
    }
    return this.addressPromise;
  }

  /**
   * Nonce = mined transaction count (never "pending"), bumped by a local counter after each send.
   * Sepolia nodes answer "pending" nonce queries inconsistently for EIP-7702 delegated accounts
   * ("gapped-nonce tx from delegated accounts"); every tx in the scripts is awaited before the next one,
   * so the mined count is the right nonce, and the local counter covers RPC nodes that lag behind.
   */
  async getTransactionCount(_blockTag?: BlockTag): Promise<number> {
    const address = await this.getAddress();
    let mined = await this.provider!.getTransactionCount(address, 'latest');
    // If the node lags behind what we've already sent, wait for it to catch up instead of submitting a
    // too-high nonce ("gapped-nonce tx from delegated accounts").
    for (let i = 0; i < 20 && mined < this.nextNonce; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      mined = await this.provider!.getTransactionCount(address, 'latest');
    }
    return Math.max(mined, this.nextNonce);
  }

  async sendTransaction(transaction: Deferrable<TransactionRequest>): Promise<TransactionResponse> {
    const response = await super.sendTransaction(transaction);
    this.nextNonce = response.nonce + 1;
    return response;
  }

  async signMessage(message: string | utils.Bytes): Promise<string> {
    const digest = utils.arrayify(utils.hashMessage(message));
    const { r, s, recoveryParam } = await this.signDigest(digest);
    return utils.joinSignature({ r, s, recoveryParam });
  }

  async signTransaction(transaction: Deferrable<TransactionRequest>): Promise<string> {
    const tx = await resolveProperties(transaction);

    if (tx.from != null) {
      const from = await this.getAddress();
      if (utils.getAddress(tx.from as string) !== from) {
        throw new Error('AwsKmsSigner: transaction `from` does not match the KMS key address');
      }
    }

    const unsignedTx: UnsignedTransaction = {
      chainId: tx.chainId ?? undefined,
      data: tx.data,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce != null ? BigNumber.from(tx.nonce).toNumber() : undefined,
      to: tx.to,
      type: tx.type ?? undefined,
      value: tx.value,
    };

    const digest = utils.arrayify(utils.keccak256(serialize(unsignedTx)));
    const signature = await this.signDigest(digest);
    return serialize(unsignedTx, signature);
  }

  private async getPublicKey(): Promise<Buffer> {
    if (!this.publicKeyPromise) {
      this.publicKeyPromise = this.kms.send(new GetPublicKeyCommand({ KeyId: this.keyId })).then((res) => {
        if (!res.PublicKey) {
          throw new Error(`KMS key ${this.keyId} returned no public key - check the key exists and is ECC_SECG_P256K1`);
        }
        return extractUncompressedPublicKey(Buffer.from(res.PublicKey));
      });
    }
    return this.publicKeyPromise;
  }

  private async signDigest(digest: Uint8Array): Promise<{ r: string; s: string; recoveryParam: number }> {
    const [address, res] = await Promise.all([
      this.getAddress(),
      this.kms.send(
        new SignCommand({
          KeyId: this.keyId,
          Message: digest,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      ),
    ]);

    if (!res.Signature) {
      throw new Error(`KMS key ${this.keyId} returned no signature`);
    }

    const der = parseDerSignature(Buffer.from(res.Signature));
    const r = toPaddedHex(der.r);
    let sBN = BigNumber.from(toPaddedHex(der.s));
    if (sBN.gt(SECP256K1_HALF_N)) {
      sBN = SECP256K1_N.sub(sBN); // normalize to low-S, as required by Ethereum
    }
    const s = utils.hexZeroPad(sBN.toHexString(), 32);

    for (const recoveryParam of [0, 1]) {
      const recovered = utils.recoverAddress(digest, { r, s, recoveryParam });
      if (recovered.toLowerCase() === address.toLowerCase()) {
        return { r, s, recoveryParam };
      }
    }
    throw new Error('AwsKmsSigner: could not determine recovery id for KMS signature');
  }
}
