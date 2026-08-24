# Family Scheduling OS — AI Action Contracts

## Core rule

The LLM does not directly modify data.

Pipeline:

User input
-> classify
-> propose structured action
-> validate schema
-> validate permissions
-> evaluate conflicts
-> require confirmation when appropriate
-> execute deterministic command
-> audit

## Required action families

### Scheduling
- create_event
- update_event
- cancel_event
- create_recurring_schedule
- add_participant
- remove_participant

### Reminders
- create_reminder
- update_reminder
- complete_reminder
- snooze_reminder

### Shopping
- add_shopping_item
- update_shopping_item
- mark_shopping_item_purchased
- create_shopping_list

### Errands
- create_errand
- update_errand
- complete_errand

### Inbox
- classify_inbox_item
- convert_inbox_item
- dismiss_inbox_item

### Conflict
- check_conflicts
- explain_conflict
- suggest_resolution

### Shia Baby Employees
- create_employee
- update_employee
- assign_shift
- remove_shift_assignment
- record_availability
- request_time_off
- review_time_off
- request_shift_swap
- review_shift_swap

### Inventory
- create_inventory_item
- adjust_inventory
- receive_inventory
- update_reorder_point

### Sales
- record_sale
- record_sale_item

### Expenses
- record_expense
- update_expense

## Example action envelope

{
  "action_type": "create_event",
  "confidence": 0.97,
  "confirmation_required": true,
  "payload": {
    "member_id": "member_123",
    "category": "practice",
    "title": "Cheer Practice",
    "start_at": "2026-08-25T18:00:00-05:00",
    "end_at": "2026-08-25T20:00:00-05:00",
    "recurrence": {
      "frequency": "weekly",
      "weekdays": ["TU", "TH"]
    }
  }
}

## Confirmation policy

Require confirmation when:
- creating or editing important calendar events
- deleting/canceling events
- changing recurrence for a series
- assigning/removing employees from shifts
- resolving conflicts through schedule changes
- modifying inventory counts beyond a safe threshold
- recording financial data from ambiguous input

May execute without extra confirmation when user intent is explicit and low-risk, depending on product policy:
- add shopping item
- add simple reminder
- create inbox item

## Validation requirements

Every action must validate:
- user permission
- household/business scope
- referenced entity existence
- date/time sanity
- recurrence sanity
- required fields
- enum values
- duplicate-risk checks
- tenant isolation

## Conflict engine is deterministic

AI can explain conflicts, but the actual detection logic must be deterministic.

Conflict examples:
- same member overlaps
- same responsible adult overlaps
- work shift vs family event
- employee unavailable
- employee double-booked
- missing opener/closer
- insufficient coverage

## Morning brief

AI receives structured, already-authorized data and produces a concise natural-language summary.

Do not allow it to query arbitrary tenant data without permission-aware retrieval.
