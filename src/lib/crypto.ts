// Encryption at rest (SPEC.md: "encrypt secrets").
// Receipt files and email text are encrypted with AES-256-GCM before they touch the disk
// or the database. Without ENCRYPTION_KEY the stored data is unreadable.
// Format: [1 byte version][12 byte IV][16 byte auth tag][ciphertext]
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = 1;

export class Encryptor {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, "hex");
    if (this.key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }

  encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(sealed: Buffer): Buffer {
    if (sealed.length < 29 || sealed[0] !== VERSION) throw new Error("Unknown encrypted data format");
    const iv = sealed.subarray(1, 13);
    const tag = sealed.subarray(13, 29);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  }

  encryptText(text: string): string {
    return this.encrypt(Buffer.from(text, "utf8")).toString("base64");
  }

  decryptText(sealed: string): string {
    return this.decrypt(Buffer.from(sealed, "base64")).toString("utf8");
  }
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
