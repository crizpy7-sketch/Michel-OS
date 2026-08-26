/**
 * Michel-OS — Global search (Agent K).
 *
 * ARCHITECTURE.md §4 lists search as cross-cutting, which is exactly what makes
 * it dangerous: a search box that reaches every table is the shortest path to
 * a privacy leak. Two rules keep it honest:
 *
 *   1. **Search never reads a domain's tables.** Domains hand it
 *      `SearchDocument`s; the index holds only what it was given. A domain that
 *      does not want something searchable simply does not push it, rather than
 *      relying on the search layer to remember an exception.
 *   2. **Every hit is filtered twice** — once by household, once by what the
 *      searching member may see. An employee holds `business.read` but not
 *      `event.read`, so the family calendar is invisible to them here for the
 *      same reason it is invisible everywhere else: the answer comes from
 *      `authorize()`, not from a rule this module invented.
 *
 * Ranking is deterministic: same index, same query, same order, every time.
 * A search that reshuffles between two identical queries teaches people not to
 * trust the first result.
 */

import { authorize } from '../household/permissions.ts';
import {
  type Member,
  type Permission,
  type SearchDocument,
  type SearchEntity,
  type SearchHit,
  type UUID,
} from '../../lib/contracts/index.ts';

/* ------------------------------------------------------------ visibility */

/**
 * What a member must hold to see each kind of row.
 *
 * Written as a table so that adding a searchable entity forces an explicit
 * decision about who may see it. A missing entry means "nobody", not
 * "everybody" — the default has to fail closed.
 */
const REQUIRED_PERMISSION: Readonly<Record<SearchEntity, Permission>> = Object.freeze({
  event: 'event.read',
  reminder: 'event.read',
  errand: 'event.read',
  shopping_item: 'event.read',
  inbox_item: 'event.read',
  member: 'event.read',
  employee: 'business.read',
  product: 'business.read',
  expense: 'finance.read',
});

/* ------------------------------------------------------------- tokenising */

/**
 * Fold a string into comparable tokens.
 *
 * Diacritics are stripped so "Leila" finds "Leïla", and everything is
 * lowercased. Deliberately not a stemmer: "practice" must not silently match
 * "practical" in a family calendar, where a wrong match costs more than a
 * missed one.
 */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((token) => token.length > 0);
}

/* ------------------------------------------------------------------ index */

interface IndexedDocument {
  doc: SearchDocument;
  titleTokens: string[];
  bodyTokens: string[];
}

/**
 * An immutable index. Rebuilt rather than mutated, so a search can never
 * observe a half-applied update.
 */
export class SearchIndex {
  readonly #documents: IndexedDocument[];

  private constructor(documents: IndexedDocument[]) {
    this.#documents = documents;
  }

  static build(documents: readonly SearchDocument[]): SearchIndex {
    const indexed: IndexedDocument[] = [];
    const seen = new Set<string>();

    for (const doc of documents) {
      if (typeof doc?.id !== 'string' || doc.id.length === 0) continue;
      if (typeof doc.householdId !== 'string' || doc.householdId.length === 0) continue;
      // Last write wins, and the winner is deterministic: a later push for the
      // same key replaces the earlier one rather than producing two hits.
      const key = `${doc.entity}:${doc.householdId}:${doc.id}`;
      if (seen.has(key)) {
        const at = indexed.findIndex((d) => `${d.doc.entity}:${d.doc.householdId}:${d.doc.id}` === key);
        indexed.splice(at, 1);
      }
      seen.add(key);
      indexed.push({
        doc,
        titleTokens: tokenize(doc.title ?? ''),
        bodyTokens: tokenize(doc.body ?? ''),
      });
    }

    return new SearchIndex(indexed);
  }

  get size(): number {
    return this.#documents.length;
  }

  /** Read-only view, for callers that need to reason about what is indexed. */
  documents(): readonly SearchDocument[] {
    return this.#documents.map((d) => d.doc);
  }

  /** @internal — used by `search`. */
  entries(): readonly IndexedDocument[] {
    return this.#documents;
  }
}

/* ----------------------------------------------------------------- search */

export interface SearchOptions {
  /** Restrict to these entities. Absent means every entity the member may see. */
  entities?: readonly SearchEntity[];
  limit?: number;
  /**
   * The business the member currently has in scope. A business row from any
   * other business is invisible even to an owner — CR-008: business scope is
   * the caller's to establish, and this module refuses anything that does not
   * match what it was told.
   */
  businessId?: UUID;
}

export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Rank a query against the index for one member.
 *
 * Scoring, in descending weight:
 *   - every query term matched (a partial match still scores, but never outranks a complete one)
 *   - a title match outweighs a body match
 *   - a whole-token match outweighs a prefix match
 *   - recency breaks what is otherwise a tie
 *
 * The final sort falls through to entity and id so that two genuinely
 * indistinguishable rows still come back in a fixed order.
 */
export function search(
  index: SearchIndex,
  query: string,
  member: Member,
  householdId: UUID,
  options: SearchOptions = {},
): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const limit = Number.isInteger(options.limit) && options.limit! > 0 ? options.limit! : DEFAULT_SEARCH_LIMIT;
  const allowedEntities = options.entities === undefined ? null : new Set(options.entities);

  // Ask the kernel once per entity kind rather than once per row.
  const visible = new Map<SearchEntity, boolean>();
  const maySee = (entity: SearchEntity): boolean => {
    const cached = visible.get(entity);
    if (cached !== undefined) return cached;
    const permission = REQUIRED_PERMISSION[entity];
    const allowed =
      permission !== undefined &&
      authorize({ member, householdId, permission, resource: { householdId } }).allowed;
    visible.set(entity, allowed);
    return allowed;
  };

  interface Scored {
    hit: SearchHit;
    score: number;
    at: string;
    entity: SearchEntity;
    id: string;
  }

  const scored: Scored[] = [];

  for (const entry of index.entries()) {
    const doc = entry.doc;
    if (doc.householdId !== householdId) continue; // tenancy, before anything else
    if (allowedEntities !== null && !allowedEntities.has(doc.entity)) continue;
    if (!maySee(doc.entity)) continue;
    // A business row is only visible inside the business scope the caller set.
    if (doc.businessId !== undefined && doc.businessId !== options.businessId) continue;

    const score = scoreDocument(entry, terms);
    if (score <= 0) continue;

    scored.push({
      score,
      at: doc.at ?? '',
      entity: doc.entity,
      id: doc.id,
      hit: {
        entity: doc.entity,
        id: doc.id,
        title: doc.title,
        score,
        snippet: snippet(doc, terms),
        ...(doc.domain === undefined ? {} : { domain: doc.domain }),
        ...(doc.at === undefined ? {} : { at: doc.at }),
      },
    });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.at !== b.at) return a.at < b.at ? 1 : -1; // newer first
    if (a.entity !== b.entity) return a.entity < b.entity ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return scored.slice(0, limit).map((s) => s.hit);
}

const TITLE_EXACT = 10;
const TITLE_PREFIX = 6;
const BODY_EXACT = 4;
const BODY_PREFIX = 2;
/** Paid once, only when every term matched somewhere. */
const ALL_TERMS_BONUS = 25;

function scoreDocument(entry: IndexedDocument, terms: readonly string[]): number {
  let score = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    let best = 0;
    for (const token of entry.titleTokens) {
      if (token === term) best = Math.max(best, TITLE_EXACT);
      else if (token.startsWith(term)) best = Math.max(best, TITLE_PREFIX);
    }
    for (const token of entry.bodyTokens) {
      if (token === term) best = Math.max(best, BODY_EXACT);
      else if (token.startsWith(term)) best = Math.max(best, BODY_PREFIX);
    }
    if (best > 0) matchedTerms += 1;
    score += best;
  }

  if (matchedTerms === 0) return 0;
  if (matchedTerms === terms.length) score += ALL_TERMS_BONUS;
  return score;
}

/**
 * A one-line excerpt with the matched terms marked by `[[` … `]]`.
 *
 * Markers rather than HTML: this string crosses into a UI that has to escape
 * it, and shipping markup out of a domain module would make that impossible to
 * do safely.
 */
function snippet(doc: SearchDocument, terms: readonly string[]): string {
  const source = (doc.body ?? '').trim().length > 0 ? doc.body!.trim() : doc.title;
  const words = source.split(/\s+/);
  const termSet = new Set(terms);

  const hitAt = words.findIndex((word) => {
    const folded = tokenize(word);
    return folded.some((token) => termSet.has(token) || [...termSet].some((t) => token.startsWith(t)));
  });

  const from = hitAt < 0 ? 0 : Math.max(0, hitAt - 4);
  const slice = words.slice(from, from + 16);

  const marked = slice.map((word) => {
    const folded = tokenize(word);
    const isHit = folded.some((token) => termSet.has(token) || [...termSet].some((t) => token.startsWith(t)));
    return isHit ? `[[${word}]]` : word;
  });

  const prefix = from > 0 ? '… ' : '';
  const suffix = from + 16 < words.length ? ' …' : '';
  return `${prefix}${marked.join(' ')}${suffix}`;
}
