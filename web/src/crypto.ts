// Random tokens, hashing, and encryption for what's stored in KV. Uses the
// Web Crypto API built into Workers.
import type { Env } from "./env";
import { configError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A random, URL-safe string with `bytes` bytes of randomness. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function encryptionKey(env: Env): Promise<CryptoKey> {
  if (cachedKey?.secret !== env.TOKEN_KEY) {
    const raw = env.TOKEN_KEY ? fromBase64(env.TOKEN_KEY) : new Uint8Array();
    if (raw.length !== 32) throw configError("TOKEN_KEY must be 32 random bytes, base64-encoded (see web/README.md).");
    cachedKey = {
      secret: env.TOKEN_KEY,
      key: crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
    };
  }
  return cachedKey.key;
}

/** AES-GCM: a fresh 12-byte nonce, then the ciphertext, as base64. */
export async function encrypt(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), encoder.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

export async function decrypt(env: Env, data: string): Promise<string> {
  const bytes = fromBase64(data);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await encryptionKey(env),
    bytes.slice(12),
  );
  return decoder.decode(plain);
}

/** PKCE: the challenge Google gets for a verifier we keep. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier);
}
