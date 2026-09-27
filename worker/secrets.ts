const encoder = new TextEncoder();
const decoder = new TextDecoder();
let cached: { source: string; key: Promise<CryptoKey> } | undefined;

function keyFor(hex: string): Promise<CryptoKey> {
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error("TOKEN_KEY must contain 64 hexadecimal characters");
  if (cached?.source === hex) return cached.key;
  const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  cached = { source: hex, key };
  return key;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  ) as Uint8Array<ArrayBuffer>;
}

export async function seal(value: string, keyHex: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await keyFor(keyHex),
      encoder.encode(value),
    ),
  );
  return `v1.${encode(iv)}.${encode(ciphertext)}`;
}

export async function unseal(value: string, keyHex: string): Promise<string> {
  const [version, ivText, ciphertextText] = value.split(".");
  if (version !== "v1" || !ivText || !ciphertextText) throw new Error("Stored token is invalid");
  const iv = decode(ivText);
  const ciphertext = decode(ciphertextText);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await keyFor(keyHex),
    ciphertext,
  );
  return decoder.decode(plaintext);
}
