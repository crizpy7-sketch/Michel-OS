# Family Scheduling OS — Product Specification

## 1. Product concept

One premium family operating system containing multiple specialized schedule mini-apps, coordinated by one AI scheduling brain.

The user should be able to say:

> "Leila has practice every Tuesday and Thursday from 6 to 8."

The system should:
- identify the person
- identify the schedule type
- infer recurrence
- place it in Practice
- detect conflicts
- propose reminders
- ask for confirmation when needed
- save only through validated deterministic actions

## 2. Home screen

The home screen should feel like an iPhone home screen for family life, not like a generic calendar.

Top summary:
- greeting
- date
- events today
- reminders
- shopping items
- conflicts

Mini-app grid:
- Appointments
- Practice
- Shia Baby
- School
- Competition
- Games
- Errands
- Hubby Work
- Shopping
- Reminders
- AI Assistant
- All Schedules
- Inbox

## 3. Mini-apps

### Appointments
- medical
- dental
- salon
- reservations
- meetings
- services
- provider
- location
- reminders
- attachments

### Practice
- recurring sports/activity practice
- child/member
- team/activity
- coach
- location
- arrival time
- equipment
- uniform
- recurrence

### Competition
- competition name
- athlete
- venue
- arrival
- check-in
- warm-up
- performance
- awards
- packing list
- uniform
- tickets/docs

### Games
- athlete
- Valley Cats identity
- opponent
- home/away
- venue
- arrival
- game time
- uniform
- equipment
- score/result
- season record

### School
- drop-off
- pickup
- holidays
- early release
- picture day
- testing
- teacher meetings
- assignments/projects
- field trips
- school documents

### Errands
Physical actions that require going somewhere or completing a task:
- returns
- pharmacy pickup
- mail package
- school pickup
- bank
- paperwork

### Shopping
Things that need to be purchased:
- groceries
- household
- kids
- clothing
- school
- business
- home
- hardware

AI may group by store.

### Reminders
Things that need to be remembered:
- call insurance
- charge tablets
- renew registration
- wash uniform
- bring documents
- recurring reminders
- snooze
- complete

### Hubby Work
- jobsite
- project
- building/area
- shift
- overtime
- travel
- work type
- notes
- scaffold design/CAD context

### Shia Baby Business Hub
Sections:
- Overview
- Schedule
- Employees
- Inventory
- Sales
- Orders
- Expenses
- Tax Set-Aside
- AI Insights

### Inbox
The user can dump unorganized information:
- "we need milk"
- "Mateo plays Saturday at 4"
- "remind me about this flyer"
- "Maria cannot work Thursday"

AI classifies and routes the item into the correct mini-app.

## 4. Shia Baby employee scheduling

Support:
- employees
- roles
- availability
- preferred hours
- weekly scheduled hours
- shifts
- opening/mid/closing
- time-off requests
- shift swaps
- schedule publishing
- coverage rules

Warnings:
- unavailable employee
- double booking
- no opener
- no closer
- inadequate coverage
- excessive hours
- conflict with family obligations

## 5. Shia Baby inventory

Support:
- product
- SKU
- barcode
- category
- quantity
- reorder point
- cost
- retail price
- supplier
- inventory movement
- low-stock alerts

## 6. Shia Baby sales

Support V1 basic/manual or imported sales:
- daily sales
- weekly sales
- monthly sales
- orders
- average order
- top products
- slow products

Do not build full accounting.

## 7. Shia Baby expenses

Track:
- vendor
- category
- amount
- date
- description
- receipt attachment

## 8. Tax Set-Aside

Use the label **Tax Set-Aside**, not "Taxes Owed", unless connected to authoritative accounting.

Show:
- recorded taxable sales
- tax collected if available
- estimated reserve
- reserved amount
- remaining estimated reserve

Display disclaimer that estimates are not tax filing or professional tax calculations.

## 9. All Schedules

Views:
- Today
- Day
- Week
- Month
- Agenda

Filters:
- household member
- mini-app/category
- business
- school
- sports
- appointments
- work
- reminders

## 10. Morning Brief

Show:
- today's events
- tomorrow preview
- conflicts
- reminders
- errands
- shopping count
- Shia Baby staffing warnings
- important upcoming competition/game

## 11. Conflict intelligence

Level 1:
- direct overlapping events

Level 2:
- same responsible adult needed for multiple children

Level 3:
- arrival/preparation overlap

Level 4:
- work shift vs family obligation

Level 5:
- employee availability/coverage conflict

Future:
- travel-time conflicts using maps

## 12. AI conflict resolution

AI may suggest:
- another responsible adult
- different event time
- different employee
- move appointment
- combine errands
- preparation time

Important events must not be automatically changed without confirmation.

## 13. Icon direction

Do not use emoji as app icons.

Custom premium 3D assets:
- Appointments: dimensional calendar + clock
- Practice: shiny/glittery red and blue pom-poms
- Shia Baby: approved teddy bear artwork
- School: premium academic icon
- Competition: gold championship trophy
- Games: blue/red Valley Cats wildcat + football
- Errands: green/cream/gold tote + checklist
- Hubby Work: computer + scaffold design software/technical drawing
- Shopping: premium cart/basket + bags/products
- Reminders: premium bell/notification jewel
- AI Assistant: premium AI identity
- All Schedules: unified calendar identity
- Inbox: premium intake/inbox icon

## 14. Acceptance criteria

V1 is not complete until users can:
1. authenticate
2. create/join household
3. add members
4. create appointments
5. create recurring practices
6. create games
7. create competitions
8. create school events
9. create work schedules
10. create errands
11. create shopping items
12. create reminders
13. use Inbox
14. view All Schedules
15. detect conflicts
16. receive conflict explanations
17. use AI natural-language entry
18. preview AI actions
19. create Shia Baby employees
20. assign shifts
21. track availability
22. track inventory
23. record sales
24. record expenses
25. view Tax Set-Aside estimate
26. receive low-stock warnings
27. view Morning Brief
28. search system-wide
29. use comfortably on mobile, iPad/tablet, and desktop
