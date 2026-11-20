// Listing screenshots. They are public (shown on the listing page), so they are not encrypted,
// but names are random and the file type is checked from the bytes, not the file name.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } as const;
export type ImageType = keyof typeof EXT;
const KEY = /^([a-z0-9]{20,40})\/([a-f0-9-]{36})\.(jpg|png|webp)$/;

export class MediaStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root, "listings");
  }

  async save(listingId: string, data: Buffer, type: ImageType): Promise<string> {
    if (!/^[a-z0-9]{20,40}$/.test(listingId)) throw new Error("bad listing id");
    const dir = path.join(this.root, listingId);
    await mkdir(dir, { recursive: true });
    const key = `${listingId}/${randomUUID()}${EXT[type]}`;
    await writeFile(path.join(this.root, key), data, { mode: 0o644 });
    return key;
  }

  /** Returns the file and its content type, or null for anything that isn't a stored image key. */
  async read(key: string): Promise<{ data: Buffer; type: string } | null> {
    const m = KEY.exec(key);
    if (!m) return null;
    try {
      const data = await readFile(path.join(this.root, m[1], `${m[2]}.${m[3]}`));
      return { data, type: m[3] === "jpg" ? "image/jpeg" : `image/${m[3]}` };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    if (KEY.test(key)) await rm(path.join(this.root, key), { force: true });
  }

  async removeListing(listingId: string): Promise<void> {
    if (/^[a-z0-9]{20,40}$/.test(listingId)) await rm(path.join(this.root, listingId), { recursive: true, force: true });
  }
}
