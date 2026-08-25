import type { ReactNode } from 'react';
import { AppShell } from '../../components/navigation/AppShell.tsx';

/**
 * DASHBOARD SHELL — wraps every screen in the product.
 *
 * Any route inside `app/(dashboard)/` gets, for free:
 *   - a skip link as the first focusable element on the page
 *   - the navigation, in whichever of its three forms fits the viewport
 *     (bottom tab bar < 768px · icon rail >= 768px · sidebar >= 1280px)
 *   - a slim top bar with global search and the inbox
 *   - `<main id="main-content" tabindex="-1">` with the correct bottom
 *     padding so the phone tab bar never covers the last row of content
 *
 * Screens render their own `<PageHeader>` and content inside
 * `<PageContainer>`; they must not render another `<main>`, another `<nav>`
 * labelled "Primary", or a second `<h1>`.
 *
 * Deliberately dataless. Four screen agents build on top of this, so it does
 * no I/O and cannot fail: a shell that queries the database is a shell that
 * can take every screen down with it. Badge counts are a prop
 * (`<AppShell badges={{ inbox: 4 }}>`) for whenever a data owner wants to
 * pass them in from a route that already has the numbers.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
