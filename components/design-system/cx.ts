/**
 * Minimal class-name joiner.
 *
 * Deliberately not `clsx` — one 12-line function beats a dependency, and it
 * keeps every variant map in this package a plain object of *literal* class
 * strings, which is what Tailwind v4's source scanner needs in order to see
 * them. Never build a class name by interpolation (`text-${tone}-500`); look
 * it up in a `Record<Variant, string>` instead.
 */
export type ClassValue = string | number | null | undefined | false | ClassValue[];

export function cx(...parts: ClassValue[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part && part !== 0) continue;
    if (Array.isArray(part)) {
      const nested = cx(...part);
      if (nested) out.push(nested);
    } else {
      out.push(String(part));
    }
  }
  return out.join(' ');
}
