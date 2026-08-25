/**
 * DESIGN SYSTEM PREVIEW — a living styleguide, not a screen.
 *
 * The product's screens are owned by the screen agents. This route exists so
 * the design system can be *seen* — by a person, and by the browser probe —
 * before any screen mounts, and so a token or primitive regression shows up as
 * a visual diff rather than being discovered inside a feature later.
 *
 * Owned by the orchestrator. Not part of the product navigation.
 */
import { Button } from '../../components/design-system/Button.tsx';
import { Card } from '../../components/design-system/Card.tsx';
import { Pill } from '../../components/design-system/Pill.tsx';
import { Stack } from '../../components/design-system/Stack.tsx';
import { PageHeader, SectionHeading } from '../../components/design-system/PageHeader.tsx';
import { Callout } from '../../components/design-system/Callout.tsx';
import { EmptyState } from '../../components/design-system/EmptyState.tsx';
import { Skeleton } from '../../components/design-system/Skeleton.tsx';
import { MINI_APP_LIST, PENDING_ART } from '../../components/design-system/miniApps.ts';

export const metadata = { title: 'Design system — Michel-OS' };

const SWATCHES: Array<{ name: string; className: string }> = [
  { name: 'canvas', className: 'bg-canvas' },
  { name: 'surface', className: 'bg-surface' },
  { name: 'surface sunken', className: 'bg-surface-sunken' },
  { name: 'surface inverse', className: 'bg-surface-inverse' },
  { name: 'accent', className: 'bg-accent' },
  { name: 'accent soft', className: 'bg-accent-soft' },
  { name: 'ok', className: 'bg-ok' },
  { name: 'warn', className: 'bg-warn' },
  { name: 'critical', className: 'bg-critical' },
];

const TYPE_SCALE: Array<{ token: string; className: string }> = [
  { token: 'text-3xl', className: 'text-3xl font-display' },
  { token: 'text-2xl', className: 'text-2xl font-display' },
  { token: 'text-xl', className: 'text-xl' },
  { token: 'text-lg', className: 'text-lg' },
  { token: 'text-md', className: 'text-md' },
  { token: 'text-base', className: 'text-base' },
  { token: 'text-sm', className: 'text-sm' },
  { token: 'text-xs', className: 'text-xs' },
];

export default function DesignSystemPreview() {
  return (
    <main className="bg-canvas text-ink min-h-screen">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <PageHeader
          eyebrow="Michel-OS"
          title="Design system"
          subtitle="Tokens and primitives, rendered. Screens mount on top of these."
          meta={<Pill tone="accent">{MINI_APP_LIST.length} mini-apps registered</Pill>}
        />

        <Stack direction="col" gap={10} className="mt-10">
          <section aria-labelledby="ds-color">
            <SectionHeading id="ds-color">Color</SectionHeading>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {SWATCHES.map((s) => (
                <Card key={s.name} tone="flat" padding="xs">
                  <div className={`${s.className} border-line h-14 w-full rounded-lg border`} />
                  <p className="text-ink-muted mt-2 text-2xs uppercase tracking-wide">{s.name}</p>
                </Card>
              ))}
            </div>
          </section>

          <section aria-labelledby="ds-type">
            <SectionHeading id="ds-type">Typography</SectionHeading>
            <Card tone="flat" padding="md" className="mt-4">
              <Stack direction="col" gap={3}>
                {TYPE_SCALE.map((t) => (
                  <div key={t.token} className="flex items-baseline gap-4">
                    <span className="text-ink-subtle w-24 shrink-0 font-mono text-2xs">{t.token}</span>
                    <span className={t.className}>Wednesday looks busy</span>
                  </div>
                ))}
              </Stack>
            </Card>
          </section>

          <section aria-labelledby="ds-buttons">
            <SectionHeading id="ds-buttons">Buttons</SectionHeading>
            <Card tone="flat" padding="md" className="mt-4">
              <Stack direction="row" gap={3} align="center" className="flex-wrap">
                <Button variant="primary">Add event</Button>
                <Button variant="quiet">Cancel</Button>
                <Button variant="ghost">Skip</Button>
                <Button variant="danger">Delete</Button>
                <Button variant="primary" disabled>
                  Disabled
                </Button>
                <Button variant="primary" loading>
                  Saving
                </Button>
              </Stack>
            </Card>
          </section>

          <section aria-labelledby="ds-status">
            <SectionHeading id="ds-status">Status and severity</SectionHeading>
            <p className="text-ink-muted mt-2 text-sm">
              Severity is never carried by color alone — each tone pairs with a written label.
            </p>
            <Stack direction="row" gap={2} className="mt-4 flex-wrap">
              <Pill tone="neutral">Draft</Pill>
              <Pill tone="accent">Shia Baby</Pill>
              <Pill tone="ok">Confirmed</Pill>
              <Pill tone="info">Travel gap</Pill>
              <Pill tone="warn">Overlap</Pill>
              <Pill tone="critical">Unsupervised</Pill>
            </Stack>
            <Stack direction="col" gap={3} className="mt-5">
              <Callout tone="critical" title="Michel is double-booked">
                Soccer practice and Noor’s dentist overlap Wednesday from 4:30 to 5:00.
              </Callout>
              <Callout tone="warn" title="Wednesday close has no one on it">
                The shop is published as open with no closer scheduled.
              </Callout>
            </Stack>
          </section>

          <section aria-labelledby="ds-surfaces">
            <SectionHeading id="ds-surfaces">Surfaces</SectionHeading>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card padding="md">
                <h3 className="text-lg">Default</h3>
                <p className="text-ink-muted mt-1 text-sm">The workhorse surface for lists and detail.</p>
              </Card>
              <Card tone="glass" padding="md">
                <h3 className="text-lg">Glass</h3>
                <p className="text-ink-muted mt-1 text-sm">For overlays that sit above content.</p>
              </Card>
              <Card tone="sunken" padding="md">
                <h3 className="text-lg">Sunken</h3>
                <p className="text-ink-muted mt-1 text-sm">Recessed groups inside a card.</p>
              </Card>
              <Card tone="inverse" padding="md">
                <h3 className="text-lg">Inverse</h3>
                <p className="mt-1 text-sm opacity-80">Reserved for emphasis, used sparingly.</p>
              </Card>
            </div>
          </section>

          <section aria-labelledby="ds-icons">
            <SectionHeading id="ds-icons">Mini-app artwork</SectionHeading>
            <p className="text-ink-muted mt-2 text-sm">
              The eight approved icons are the supplied PNGs. {PENDING_ART.length} are still awaiting final art
              and are marked pending rather than shipped as if they were finished.
            </p>
            <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
              {MINI_APP_LIST.map((app) => (
                <li key={app.id}>
                  <Card tone="flat" padding="xs" className="text-center">
                    <img
                      src={app.icon}
                      alt={app.label}
                      width={64}
                      height={64}
                      className="mx-auto h-12 w-12 rounded-xl object-contain"
                    />
                    <p className="mt-2 truncate text-2xs">{app.shortLabel}</p>
                    {app.artStatus === 'pending' ? (
                      <span className="text-warn mt-1 block text-2xs uppercase tracking-wide">pending</span>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="ds-states">
            <SectionHeading id="ds-states">Loading and empty</SectionHeading>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Card padding="md">
                <Stack direction="col" gap={3}>
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                </Stack>
              </Card>
              <Card padding="md">
                <EmptyState
                  title="Nothing on Sunday"
                  description="The first free day this week."
                  action={<Button variant="quiet">Add something</Button>}
                />
              </Card>
            </div>
          </section>
        </Stack>
      </div>
    </main>
  );
}
