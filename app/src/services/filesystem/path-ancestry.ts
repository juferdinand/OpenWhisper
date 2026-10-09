import { dirname } from "node:path";

/** Returns every native path ancestor once, ordered from the filesystem root to the leaf. */
export function rootFirstPathAncestry(path: string): string[] {
  const result: string[] = [];
  for (let cursor = path;; cursor = dirname(cursor)) {
    result.push(cursor);
    if (dirname(cursor) === cursor) return result.reverse();
  }
}
