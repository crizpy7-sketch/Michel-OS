import { getRepository, HOUSEHOLD_ID } from '../lib/db/index.ts';
import { expandOccurrences } from '../domains/scheduling/recurrence.ts';

export default function Probe() {
  const repo = getRepository();
  const events = repo.listEvents(HOUSEHOLD_ID);
  const occ = events.flatMap((e) =>
    expandOccurrences(e, { from: '2026-09-07T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' }),
  );
  return (
    <main>
      <h1>interop probe</h1>
      <p>{events.length} events, {occ.length} occurrences</p>
    </main>
  );
}
