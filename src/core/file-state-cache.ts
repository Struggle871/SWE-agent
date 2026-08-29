import fs from "node:fs/promises";
import { createHash } from "node:crypto";

export interface FileSnapshot {
  canonicalPath: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
  fileId?: string;
}

export class FileStateCache {
  private cache = new Map<string, FileSnapshot>();

  async markRead(file: string): Promise<void> {
    const snapshot = await this.currentSnapshot(file);
    if (snapshot) this.cache.set(key(snapshot.canonicalPath), snapshot);
  }

  async markWritten(file: string): Promise<void> {
    await this.markRead(file);
  }

  has(file: string): boolean {
    return this.cache.has(key(file));
  }

  get(file: string): FileSnapshot | undefined {
    return this.cache.get(key(file));
  }

  async currentSnapshot(file: string): Promise<FileSnapshot | null> {
    try {
      const canonicalPath = await fs.realpath(file);
      const content = await fs.readFile(canonicalPath);
      const stat = await fs.stat(canonicalPath);
      return {
        canonicalPath,
        contentHash: createHash("sha256").update(content).digest("hex"),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileId: typeof stat.ino === "number" ? String(stat.ino) : undefined,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async assertFresh(file: string): Promise<string | null> {
    const current = await this.currentSnapshot(file);
    if (!current) return null;
    const previous = this.cache.get(key(current.canonicalPath));
    if (!previous) return `文件 ${current.canonicalPath} 尚未读取。请先使用 read_file 读取最新内容后再编辑。`;
    if (
      current.contentHash !== previous.contentHash || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs ||
      (previous.fileId !== undefined && current.fileId !== previous.fileId)
    ) return `文件 ${current.canonicalPath} 自上次读取后已被修改，请重新使用 read_file 获取最新内容。`;
    return null;
  }

  clear(): void {
    this.cache.clear();
  }
}

function key(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
