import 'server-only';

/**
 * Who is using the app right now.
 *
 * V1 has no identity provider wired up, so the acting member is held in a
 * cookie and defaults to the household owner. That is a real limitation and it
 * is written down rather than hidden: `docs/app-notes.md` lists it, and
 * ARCHITECTURE.md §8's "no trusting client-provided roles" still holds, because
 * the cookie only names *which member* is acting — it can never grant a
 * capability. Every permission answer comes from the frozen role matrix keyed
 * on the member row read from the database, not from anything the client sent.
 *
 * Swapping in Supabase Auth means changing `currentMember()` alone.
 */
import { cookies } from 'next/headers';
import { getRepository, HOUSEHOLD_ID } from './db/index.ts';
import { permissionOracle } from '../domains/household/permissions.ts';
import type { Member, Permission, UUID } from './contracts/index.ts';

export const ACTING_MEMBER_COOKIE = 'michel-os.member';

export interface Session {
  householdId: UUID;
  member: Member;
  can: (permission: Permission) => boolean;
}

export async function currentSession(): Promise<Session> {
  const repo = getRepository();
  const members = repo.listMembers(HOUSEHOLD_ID);

  const jar = await cookies();
  const requested = jar.get(ACTING_MEMBER_COOKIE)?.value;

  // The cookie is a hint, not an authority: it can only select among members
  // that already belong to this household. An unknown id falls back to the
  // owner rather than being trusted.
  const member =
    members.find((m) => m.id === requested && m.active) ??
    members.find((m) => m.role === 'owner') ??
    members[0];

  if (!member) throw new Error('Household has no members; the database was not seeded.');

  return {
    householdId: HOUSEHOLD_ID,
    member,
    can: permissionOracle(member, HOUSEHOLD_ID),
  };
}
