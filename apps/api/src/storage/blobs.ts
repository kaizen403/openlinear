import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredBlob {
  storageKey: string;
  checksumSha256: string;
  size: number;
}

export interface BlobStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<StoredBlob>;
  get(key: string): Promise<Buffer>;
}

class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Buffer, _contentType: string): Promise<StoredBlob> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return {
      storageKey: key,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }
}

/**
 * Chat attachments. Local disk by default; set AZURE_STORAGE_CONNECTION_STRING
 * later to swap in Blob without changing callers.
 */
export function createBlobStore(): BlobStore {
  const root = process.env.OPENLINEAR_BLOB_DIR || join(process.cwd(), 'uploads');
  return new LocalBlobStore(root);
}
