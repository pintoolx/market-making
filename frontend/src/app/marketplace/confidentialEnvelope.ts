import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

export type ConfidentialEnvelope = {
  version: 1;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
};

const DOMAIN_TEXT = 'pintool/confidential-envelope/v1';
const DOMAIN = new TextEncoder().encode(DOMAIN_TEXT);
const HEX_32 = /^[0-9a-fA-F]{64}$/;

const fromHex = (value: string): Uint8Array => {
  const normalized = value.replace(/^0x/, '');
  if (!HEX_32.test(normalized)) throw new Error('The confidential workflow public key is invalid.');
  return Uint8Array.from(normalized.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
};

const toHex = (value: Uint8Array): string => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');

export function sealForConfidentialWorkflow(value: unknown, publicKeyHex: string, maker: string): ConfidentialEnvelope {
  const ephemeralPrivateKey = randomBytes(32);
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, fromHex(publicKeyHex));
  const nonce = randomBytes(24);
  const key = hkdf(sha256, sharedSecret, DOMAIN, DOMAIN, 32);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const context = new TextEncoder().encode(`${DOMAIN_TEXT}|maker=${maker.toLowerCase()}`);
  const ciphertext = xchacha20poly1305(key, nonce, context).encrypt(plaintext);
  return { version: 1, ephemeralPublicKey: toHex(ephemeralPublicKey), nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
}
