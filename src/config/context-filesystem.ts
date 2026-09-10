import fs, { type Dirent } from "node:fs";
import path from "node:path";

export interface ContextFileSystem {
  exists(candidate: string): boolean;
  isFile(candidate: string): boolean;
  isDirectory(candidate: string): boolean;
  readBytes(candidate: string): Buffer;
  readText(candidate: string): string;
  readDirectory(candidate: string): Dirent[];
  realpath(candidate: string): string;
}

/** Read-only canonical-path boundary for configuration context sources. */
export class ScopedContextFileSystem implements ContextFileSystem {
  private readonly roots: string[];

  constructor(readRoots: readonly string[]) {
    if (readRoots.length === 0) throw new Error("context filesystem 至少需要一个 readable root");
    this.roots = [...new Set(readRoots.map((root) => canonicalOrResolved(root).toLowerCase()))];
  }

  exists(candidate: string): boolean {
    try { this.authorize(candidate, true); return true; } catch (error) {
      if (error instanceof MissingContextPathError) return false;
      throw error;
    }
  }

  isFile(candidate: string): boolean {
    try { return fs.statSync(this.authorize(candidate, true)).isFile(); } catch (error) {
      if (error instanceof MissingContextPathError) return false;
      throw error;
    }
  }

  isDirectory(candidate: string): boolean {
    try { return fs.statSync(this.authorize(candidate, true)).isDirectory(); } catch (error) {
      if (error instanceof MissingContextPathError) return false;
      throw error;
    }
  }

  readBytes(candidate: string): Buffer { return fs.readFileSync(this.authorize(candidate, true)); }
  readText(candidate: string): string { return fs.readFileSync(this.authorize(candidate, true), "utf8"); }
  readDirectory(candidate: string): Dirent[] { return fs.readdirSync(this.authorize(candidate, true), { withFileTypes: true }); }
  realpath(candidate: string): string { return this.authorize(candidate, true); }

  private authorize(candidate: string, mustExist: boolean): string {
    const absolute = path.resolve(candidate);
    let canonical: string;
    try { canonical = fs.realpathSync.native(absolute); }
    catch (error) {
      if (mustExist) throw new MissingContextPathError(absolute, { cause: error });
      canonical = absolute;
    }
    if (!this.roots.some((root) => isWithin(root, canonical.toLowerCase()))) {
      throw new Error(`context read 越出允许根目录: ${absolute}`);
    }
    return canonical;
  }
}

class MissingContextPathError extends Error {
  constructor(candidate: string, options?: ErrorOptions) { super(`context path 不存在: ${candidate}`, options); }
}

function canonicalOrResolved(value: string): string {
  try { return fs.realpathSync.native(path.resolve(value)); } catch { return path.resolve(value); }
}
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
