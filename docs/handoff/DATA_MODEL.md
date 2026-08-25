# Family Scheduling OS — Core Data Model

This file defines the shared conceptual model. Codex should convert it into concrete SQL migrations and generated TypeScript types.

## Household

Household
- id
- name
- owner_user_id
- timezone
- created_at
- updated_at

HouseholdMember
- id
- household_id
- user_id nullable
- display_name
- member_type
- role
- avatar_url
- active
- created_at
- updated_at

Member types:
- adult
- child
- dependent
- guest

Roles:
- household_owner
- household_admin
- adult_member
- child_profile

## Schedule

Schedule
- id
- household_id
- name
- category
- owner_member_id nullable
- business_id nullable
- active
- created_at
- updated_at

Categories:
- appointments
- practice
- school
- competition
- games
- errands
- hubby_work
- shopping
- reminders
- shia_baby
- general

## Event

Event
- id
- household_id
- schedule_id
- title
- description
- category
- subcategory
- start_at
- end_at
- timezone
- all_day
- location_id nullable
- recurrence_rule_id nullable
- priority
- status
- organizer_member_id nullable
- responsible_member_id nullable
- source
- metadata jsonb
- created_by_user_id
- created_at
- updated_at
- deleted_at nullable

EventParticipant
- id
- event_id
- member_id
- participant_role
- required
- created_at

## Recurrence

RecurrenceRule
- id
- rule_text
- timezone
- starts_on
- ends_on nullable
- created_at

RecurrenceException
- id
- recurrence_rule_id
- occurrence_date
- exception_type
- replacement_event_id nullable
- created_at

## Reminder

Reminder
- id
- household_id
- member_id nullable
- event_id nullable
- title
- notes
- due_at nullable
- due_date nullable
- recurrence_rule_id nullable
- priority
- status
- snoozed_until nullable
- created_by_user_id
- created_at
- updated_at

## Errands

Errand
- id
- household_id
- assigned_member_id nullable
- title
- notes
- location_id nullable
- due_at nullable
- priority
- status
- related_event_id nullable
- created_at
- updated_at

## Shopping

ShoppingList
- id
- household_id
- name
- owner_member_id nullable
- active
- created_at

ShoppingItem
- id
- shopping_list_id
- name
- quantity
- category
- preferred_store
- assigned_member_id nullable
- priority
- notes
- purchased
- related_event_id nullable
- created_at
- updated_at

## Inbox

InboxItem
- id
- household_id
- created_by_user_id
- raw_input
- input_type
- classification_status
- proposed_action jsonb nullable
- linked_entity_type nullable
- linked_entity_id nullable
- created_at
- resolved_at nullable

## Locations

Location
- id
- household_id nullable
- name
- address
- latitude nullable
- longitude nullable
- notes
- created_at

## Conflicts

Conflict
- id
- household_id
- conflict_type
- severity
- status
- event_a_id nullable
- event_b_id nullable
- member_id nullable
- employee_id nullable
- explanation
- metadata jsonb
- created_at
- resolved_at nullable

Severity:
- info
- warning
- critical

Status:
- open
- resolved
- ignored

## Generic relationships

EntityLink
- id
- household_id
- source_type
- source_id
- target_type
- target_id
- relationship
- created_at

## Shia Baby Business

Business
- id
- household_id
- name
- active
- created_at
- updated_at

Employee
- id
- business_id
- name
- role
- email nullable
- phone nullable
- status
- preferred_weekly_hours nullable
- max_weekly_hours nullable
- notes
- created_at
- updated_at

EmployeeAvailability
- id
- employee_id
- weekday
- available_from nullable
- available_to nullable
- unavailable
- effective_from nullable
- effective_to nullable

Shift
- id
- business_id
- start_at
- end_at
- shift_type
- status
- notes
- created_at
- updated_at

ShiftAssignment
- id
- shift_id
- employee_id
- assignment_status
- created_at

TimeOffRequest
- id
- employee_id
- starts_at
- ends_at
- reason
- status
- reviewed_by_user_id nullable
- created_at

ShiftSwapRequest
- id
- business_id
- from_employee_id
- to_employee_id nullable
- shift_id
- status
- created_at

CoverageRule
- id
- business_id
- weekday
- start_time
- end_time
- minimum_employees
- required_role nullable
- active

## Inventory

Product
- id
- business_id
- name
- sku
- barcode nullable
- category
- cost nullable
- retail_price nullable
- reorder_point nullable
- supplier_id nullable
- active
- image_url nullable
- created_at
- updated_at

InventoryLocation
- id
- business_id
- name

InventoryMovement
- id
- product_id
- inventory_location_id
- movement_type
- quantity_delta
- unit_cost nullable
- reference_type nullable
- reference_id nullable
- notes
- created_at

Supplier
- id
- business_id
- name
- contact_info jsonb
- created_at

## Sales

Sale
- id
- business_id
- sold_at
- subtotal
- tax_amount nullable
- total
- source
- created_at

SaleItem
- id
- sale_id
- product_id nullable
- description
- quantity
- unit_price
- line_total

## Expenses

Expense
- id
- business_id
- vendor
- category
- amount
- expense_date
- description
- receipt_attachment_id nullable
- created_at

## Attachments

Attachment
- id
- household_id
- storage_path
- filename
- mime_type
- size_bytes
- created_by_user_id
- created_at

## AI actions

AIAction
- id
- household_id
- user_id
- action_type
- status
- input_text
- proposed_payload jsonb
- validated_payload jsonb nullable
- confirmation_required
- confirmed_at nullable
- executed_at nullable
- error_message nullable
- created_at

## Audit

AuditLog
- id
- household_id
- actor_user_id nullable
- source
- entity_type
- entity_id
- action
- previous_data jsonb nullable
- new_data jsonb nullable
- created_at
