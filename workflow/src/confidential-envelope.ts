import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { z } from 'zod'

const DOMAIN_TEXT = 'pintool/confidential-envelope/v1'
const DOMAIN = new TextEncoder().encode(DOMAIN_TEXT)
const HEX_32 = /^[0-9a-fA-F]{64}$/
const HEX_24 = /^[0-9a-fA-F]{48}$/
const HEX_CIPHERTEXT = /^[0-9a-fA-F]{32,8192}$/

export const confidentialEnvelopeSchema = z.object({
	version: z.literal(1),
	ephemeralPublicKey: z.string().regex(HEX_32),
	nonce: z.string().regex(HEX_24),
	ciphertext: z.string().regex(HEX_CIPHERTEXT),
}).strict()

export type ConfidentialEnvelope = z.infer<typeof confidentialEnvelopeSchema>

const fromHex = (value: string): Uint8Array => {
	if (value.length % 2) throw new Error('invalid hexadecimal input')
	const bytes = new Uint8Array(value.length / 2)
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
	return bytes
}

/** Decrypts a browser-sealed value only after execution has entered the TEE. */
export const openConfidentialEnvelope = (envelope: ConfidentialEnvelope, privateKeyHex: string, subject: string, scope: 'maker' | 'provider' = 'maker'): string => {
	const privateKey = privateKeyHex.replace(/^0x/, '')
	if (!HEX_32.test(privateKey)) throw new Error('confidential envelope key is invalid')
	try {
		const sharedSecret = x25519.getSharedSecret(fromHex(privateKey), fromHex(envelope.ephemeralPublicKey))
		const key = hkdf(sha256, sharedSecret, DOMAIN, DOMAIN, 32)
		const context = new TextEncoder().encode(`${DOMAIN_TEXT}|${scope}=${subject.toLowerCase()}`)
		const plaintext = xchacha20poly1305(key, fromHex(envelope.nonce), context).decrypt(fromHex(envelope.ciphertext))
		return new TextDecoder().decode(plaintext)
	} catch {
		throw new Error('confidential envelope could not be opened')
	}
}
