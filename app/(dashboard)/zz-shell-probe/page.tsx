import { PageContainer } from '../../../components/navigation/AppShell.tsx';
import { PageHeader, SectionHeading } from '../../../components/design-system/PageHeader.tsx';
import { MiniAppGrid } from '../../../components/design-system/MiniAppGrid.tsx';
import { Card, CardHeader } from '../../../components/design-system/Card.tsx';
import { Stack } from '../../../components/design-system/Stack.tsx';
import { Button, LinkButton } from '../../../components/design-system/Button.tsx';
import { SeverityPill } from '../../../components/design-system/Pill.tsx';
import { Callout } from '../../../components/design-system/Callout.tsx';
import { EmptyState } from '../../../components/design-system/EmptyState.tsx';
import { ErrorState } from '../../../components/design-system/ErrorState.tsx';
import { SkeletonList, SkeletonRegion } from '../../../components/design-system/Skeleton.tsx';

export default function ShellProbe() {
  return (
    <PageContainer>
      <PageHeader
        eyebrow="Shell probe"
        title="Good morning, Michel"
        subtitle="3 events today. 1 conflict."
        meta={<SeverityPill severity="blocking" />}
        actions={
          <>
            <Button variant="quiet">Filter</Button>
            <LinkButton href="/ai" variant="primary">Add</LinkButton>
          </>
        }
      />
      <Stack gap={6}>
        <MiniAppGrid badges={{ inbox: 4 }} hints={{ practice: '2 today' }} />
        <SectionHeading>Morning brief</SectionHeading>
        <Card accent>
          <CardHeader title="Today" meta="Wednesday, 26 August" />
        </Card>
        <Callout tone="critical" title="Parent teacher meeting overlaps cheer practice" />
        <EmptyState title="Nothing tomorrow" description="No events scheduled." />
        <ErrorState detail="ECONNREFUSED" />
        <SkeletonRegion label="Loading schedule"><SkeletonList /></SkeletonRegion>
      </Stack>
    </PageContainer>
  );
}
