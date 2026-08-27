# Engine Freeze Contract

The redesign must not change Michel OS business behavior.

Frozen systems:

1. Authentication/session behavior
2. PostgreSQL persistence and schema
3. Event/schedule creation and deletion semantics
4. Recurrence generation and weekday repair
5. Assistant proposal normalization, validation, permissions, confirmation, execution, replay protection, and audit behavior
6. Shia Baby staffing, availability, time off, coverage warnings, publishing, inventory, finance, and permissions
7. Search/notifications/inbox domain behavior
8. Shared VPS deployment semantics

Presentation code may consume these systems but must not redefine them.
