import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { card, chip, denied, empty, field, input, select, toast, withStates } from '../lib/ui.js';
import { dayShort, money, timeRange } from '../lib/format.js';

export async function render(mount, params, { setTitle }) {
  setTitle('Shia Baby');
  if (!state.can('business.read') && state.business !== null) { mount.replaceChildren(denied('Shia Baby')); return; }
  if (state.business === null) { mount.replaceChildren(createBusiness(mount)); return; }
  await load(mount, params.section ?? 'overview');
}

async function load(mount, sectionName) {
  await withStates(mount, sectionName === 'finance' ? 'dash' : 'list', async () => {
    const base = await api.get(`/api/households/${state.household.id}/business`);
    const extra = sectionName === 'staffing' ? await api.get(`/api/households/${state.household.id}/business/availability`)
      : sectionName === 'inventory' ? await api.get(`/api/households/${state.household.id}/business/inventory`)
      : sectionName === 'finance' ? await api.get(`/api/households/${state.household.id}/business/finance?period=week`) : null;
    return { base, extra };
  }, ({ base, extra }) => h('div', {}, nav(sectionName), sectionName === 'staffing' ? staffing(base, extra ?? {}, mount)
    : sectionName === 'inventory' ? inventory(base, extra, mount) : sectionName === 'finance' ? finance(base, extra, mount) : overview(base)));
}

function nav(active) {
  return h('nav', { 'aria-label': 'Shia Baby sections', style: { display: 'flex', gap: '.4rem', overflowX: 'auto', marginBottom: '1rem' } },
    ...[['overview', 'Overview'], ['staffing', 'Staffing'], ['inventory', 'Inventory'], ['finance', 'Money']].map(([key, label]) => h('a', {
      class: `btn${active === key ? ' btn--primary' : ''}`, href: key === 'overview' ? '/business' : `/business/${key}`,
    }, label)));
}

function overview(base) {
  const warnings = base.warnings ?? []; const products = base.products ?? [];
  return h('div', {},
    h('div', { class: 'dash', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '.75rem', marginBottom: '1rem' } },
      metric('Employees', base.employees?.length ?? 0), metric('Shifts', base.shifts?.length ?? 0), metric('Low stock', base.lowStock?.length ?? 0), metric('Warnings', warnings.length)),
    warnings.length ? card('Coverage & schedule warnings', null, ...warnings.slice(0, 8).map((w) => h('p', {}, chip(w.level ?? 'warning', w.level === 'blocking' ? 'alert' : 'warn'), ` ${w.message}`)))
      : card('Coverage', 'Good', h('p', { style: { color: 'var(--muted)' } }, 'No staffing warnings in the current window.')),
    products.length ? card('Inventory pulse', null, ...products.slice(0, 8).map((p) => h('p', {}, `${p.name}: ${p.quantityOnHand} on hand`))) : null,
  );
}

function staffing(base, extra, mount) {
  const employees = base.employees ?? [];
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const availability = extra.availability ?? [];
  const timeOff = extra.timeOff ?? [];
  return h('div', {},
    state.can('business.manage') ? addEmployee(mount) : null,
    state.can('employee.schedule') && employees.length ? addAvailability(employees, mount) : null,
    state.can('employee.schedule') && employees.length ? addTimeOff(employees, mount) : null,
    state.can('employee.schedule') ? addShift(base, mount) : null,
    state.can('employee.schedule') && (base.shifts ?? []).length ? publishBox(mount) : null,
    employees.length ? card('Employees', `${employees.length} active profiles`, ...employees.map((employee) => h('p', {},
      h('strong', {}, employee.displayName), scheduledHours(base, employee.id) !== null ? ` · ${scheduledHours(base, employee.id)} scheduled hours` : ''))): null,
    availability.length ? card('Weekly availability', `${availability.length} window${availability.length === 1 ? '' : 's'}`,
      ...availability.map((a) => h('p', {}, `${employeeById.get(a.employeeId)?.displayName ?? 'Employee'} · ${weekdayLabel(a.weekday)} ${minuteLabel(a.startMinute)}–${minuteLabel(a.endMinute)} · ${a.available ? 'available' : 'not available'}${a.preferredWeeklyHours === undefined ? '' : ` · prefers ${a.preferredWeeklyHours} hrs/week`}`))) : null,
    timeOff.length ? card('Time off', `${timeOff.length} request${timeOff.length === 1 ? '' : 's'}`,
      ...timeOff.slice(0, 10).map((item) => h('p', {}, `${employeeById.get(item.employeeId)?.displayName ?? 'Employee'} · ${dayShort(item.startsAt, base.business.timezone)} · ${item.status}${item.reason ? ` · ${item.reason}` : ''}`))) : null,
    (base.warnings ?? []).length ? card('Warnings', null, ...(base.warnings ?? []).map((w) => h('p', {}, chip(w.level ?? 'warning', w.level === 'blocking' ? 'alert' : 'warn'), ` ${w.message}`))) : null,
    (base.shifts ?? []).length === 0 ? empty({ title: 'No shifts scheduled', body: 'Assign employee work schedules here so coverage is visible alongside family commitments.' })
      : h('div', {}, ...(base.shifts ?? []).map((shift) => {
          const person = shift.employeeId ? employeeById.get(shift.employeeId)?.displayName ?? 'Unknown employee' : 'Unassigned';
          return card(person, shift.status ?? null, h('p', {}, `${dayShort(shift.startsAt, base.business.timezone)} · ${timeRange(shift.startsAt, shift.endsAt, base.business.timezone)}`), shift.role ? h('p', { style: { color: 'var(--muted)' } }, shift.role) : null);
        })));
}

function addEmployee(mount) {
  const name = input({ placeholder: 'Employee name', required: true }); const rate = input({ type: 'number', min: 0, step: 0.01, placeholder: 'Hourly rate (optional)' });
  return card('Add employee', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try {
    await api.post(`/api/households/${state.household.id}/business/employees`, { displayName: name.value.trim(), hourlyRateCents: rate.value ? Math.round(Number(rate.value) * 100) : undefined });
    toast('Employee added'); await load(mount, 'staffing');
  } catch (error) { toast(error.message ?? 'Could not add employee.', 'error'); } } }, field('Name', name), field('Hourly rate', rate), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add employee')));
}

function addAvailability(employees, mount) {
  const employee = select(employees.map((e) => [e.id, e.displayName]));
  const weekday = select([['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'], ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday']]);
  const start = input({ type: 'time', required: true, value: '09:00' }); const end = input({ type: 'time', required: true, value: '17:00' });
  const available = select([['true', 'Available'], ['false', 'Not available']]);
  const preferred = input({ type: 'number', min: 0, max: 168, step: 1, placeholder: 'Preferred hours/week (optional)' });
  return card('Employee availability', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try {
    await api.post(`/api/households/${state.household.id}/business/availability`, {
      employeeId: employee.value, weekday: weekday.value, startMinute: minuteValue(start.value), endMinute: minuteValue(end.value),
      available: available.value === 'true', preferredWeeklyHours: preferred.value === '' ? undefined : Number(preferred.value),
    });
    toast('Availability saved'); await load(mount, 'staffing');
  } catch (error) { toast(error.message ?? 'Could not save availability.', 'error'); } } },
    field('Employee', employee), field('Day', weekday), h('div', { class: 'split' }, field('From', start), field('To', end)), field('Status', available), field('Preferred weekly hours', preferred), h('button', { class: 'btn', type: 'submit' }, 'Save availability')));
}

function addTimeOff(employees, mount) {
  const employee = select(employees.map((e) => [e.id, e.displayName]));
  const starts = input({ type: 'datetime-local', required: true }); const ends = input({ type: 'datetime-local', required: true }); const reason = input({ placeholder: 'Reason (optional)' });
  return card('Time off', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try {
    await api.post(`/api/households/${state.household.id}/business/time-off`, { employeeId: employee.value, startsAt: starts.value, endsAt: ends.value, reason: reason.value.trim() });
    toast('Time-off request saved'); await load(mount, 'staffing');
  } catch (error) { toast(error.message ?? 'Could not save time off.', 'error'); } } }, field('Employee', employee), h('div', { class: 'split' }, field('Starts', starts), field('Ends', ends)), field('Reason', reason), h('button', { class: 'btn', type: 'submit' }, 'Add time off')));
}

function addShift(base, mount) {
  const employee = select([['', 'Unassigned'], ...(base.employees ?? []).map((e) => [e.id, e.displayName])]);
  const starts = input({ type: 'datetime-local', required: true }); const ends = input({ type: 'datetime-local', required: true }); const role = input({ placeholder: 'Role / station (optional)' });
  return card('Assign a shift', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try {
    const result = await api.post(`/api/households/${state.household.id}/business/shifts`, { employeeId: employee.value, startsAt: starts.value, endsAt: ends.value, role: role.value.trim() });
    const warnings = result.warnings ?? []; toast(warnings.length ? `Shift saved with ${warnings.length} warning(s)` : 'Shift saved', warnings.length ? 'error' : 'good'); await load(mount, 'staffing');
  } catch (error) { toast(error.message ?? 'Could not assign shift.', 'error'); } } }, field('Employee', employee), h('div', { class: 'split' }, field('Starts', starts), field('Ends', ends)), field('Role', role), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Assign shift')));
}

function publishBox(mount) {
  return card('Publish schedule', null, h('p', { style: { color: 'var(--muted)' } }, 'Publishing runs the staffing rules again. Blocking conflicts are refused instead of silently changing the schedule.'),
    h('button', { class: 'btn', type: 'button', onClick: async (e) => { e.currentTarget.disabled = true; try {
      const result = await api.post(`/api/households/${state.household.id}/business/publish`, {}); toast(`${result.published ?? 0} shift(s) published`); await load(mount, 'staffing');
    } catch (error) { toast(error.message ?? 'Schedule could not be published.', 'error'); } finally { e.currentTarget.disabled = false; } } }, 'Publish current schedule'));
}

function inventory(base, data, mount) {
  const products = data.products ?? base.products ?? []; const low = new Set((data.lowStock ?? []).map((x) => x.productId));
  return h('div', {}, state.can('business.manage') ? addProduct(mount) : null, state.can('business.manage') && products.length ? adjustStock(products, mount) : null,
    products.length === 0 ? empty({ title: 'No inventory yet', body: 'Add products to see stock and low-stock warnings.' }) : h('div', {}, ...products.map((p) => card(p.name, p.sku,
      h('p', {}, h('strong', {}, `${p.quantityOnHand} on hand`), ` · reorder at ${p.reorderPoint}`), h('p', {}, `Price ${money(p.unitPrice ?? 0)} · Cost ${money(p.unitCost ?? 0)}`), low.has(p.id) ? chip('Low stock', 'alert') : chip('Stock OK', 'good')))));
}

function addProduct(mount) {
  const sku = input({ required: true, placeholder: 'SKU-001' }); const name = input({ required: true, placeholder: 'Product name' }); const qty = input({ type: 'number', value: 0, min: 0, step: 1 }); const reorder = input({ type: 'number', value: 0, min: 0, step: 1 }); const price = input({ type: 'number', min: 0, step: 0.01, placeholder: '0.00' }); const cost = input({ type: 'number', min: 0, step: 0.01, placeholder: '0.00' });
  return card('Add product', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try {
    await api.post(`/api/households/${state.household.id}/business/products`, { sku: sku.value.trim(), name: name.value.trim(), quantityOnHand: Number(qty.value), reorderPoint: Number(reorder.value), unitPriceCents: Math.round(Number(price.value || 0) * 100), unitCostCents: Math.round(Number(cost.value || 0) * 100) }); toast('Product added'); await load(mount, 'inventory');
  } catch (error) { toast(error.message ?? 'Could not add product.', 'error'); } } }, field('SKU', sku), field('Product', name), h('div', { class: 'split' }, field('Starting quantity', qty), field('Reorder point', reorder)), h('div', { class: 'split' }, field('Price', price), field('Cost', cost)), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add product')));
}

function adjustStock(products, mount) {
  const product = select(products.map((p) => [p.id, p.name])); const kind = select([['receive', 'Receive stock'], ['return', 'Customer return'], ['shrinkage', 'Shrinkage / damage'], ['adjustment', 'Count adjustment']]); const delta = input({ type: 'number', required: true, step: 1, placeholder: 'Positive for receive/return; negative for shrinkage' });
  return card('Adjust stock', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try {
    await api.post(`/api/households/${state.household.id}/business/inventory`, { productId: product.value, kind: kind.value, quantityDelta: Number(delta.value) }); toast('Inventory updated'); await load(mount, 'inventory');
  } catch (error) { toast(error.message ?? 'Could not update inventory.', 'error'); } } }, field('Product', product), field('Movement', kind), field('Quantity change', delta, { hint: 'Receive and return require a positive number. Shrinkage requires a negative number. Adjustment can go either direction.' }), h('button', { class: 'btn', type: 'submit' }, 'Update stock')));
}

function finance(base, data, mount) {
  const sales = data.sales ?? {}; const expenses = data.expenses ?? {}; const tax = data.taxSetAside;
  return h('div', {}, h('div', { class: 'dash', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '.75rem', marginBottom: '1rem' } }, metric('Sales', money(sales.totalGrossCents ?? 0)), metric('Expenses', money(expenses.totalCents ?? 0)), metric('Tax set-aside', money(tax?.estimatedReserveCents ?? 0))),
    tax ? card(tax.label, null, h('p', {}, h('strong', {}, money(tax.estimatedReserveCents)), ` estimated reserve at ${(tax.rate * 100).toFixed(1)}%`), h('p', {}, `${money(tax.reservedCents)} recorded as reserved · ${money(tax.remainingReserveCents)} remaining`), tax.overReserved ? chip('Reserved above estimate', 'good') : null, h('p', { style: { color: 'var(--muted)', marginTop: '.75rem' } }, tax.disclaimer)) : null,
    state.can('finance.manage') ? recordExpenseBox(mount) : null, state.can('finance.manage') && (base.products ?? []).length ? recordSaleBox(base.products, mount) : null);
}

function recordExpenseBox(mount) {
  const vendor = input({ required: true, placeholder: 'Vendor' }); const category = input({ required: true, placeholder: 'Supplies, rent, shipping…' }); const amount = input({ required: true, type: 'number', min: 0, step: 0.01 });
  return card('Record expense', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try { await api.post(`/api/households/${state.household.id}/business/expenses`, { vendor: vendor.value.trim(), category: category.value.trim(), amountCents: Math.round(Number(amount.value) * 100) }); toast('Expense recorded'); await load(mount, 'finance'); } catch (error) { toast(error.message ?? 'Could not record expense.', 'error'); } } }, field('Vendor', vendor), field('Category', category), field('Amount', amount), h('button', { class: 'btn', type: 'submit' }, 'Record expense')));
}

function recordSaleBox(products, mount) {
  const product = select(products.map((p) => [p.id, `${p.name} — ${money(p.unitPrice ?? 0)}`])); const qty = input({ type: 'number', min: 1, step: 1, value: 1, required: true });
  return card('Record sale', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try { const picked = products.find((p) => p.id === product.value); await api.post(`/api/households/${state.household.id}/business/sales`, { items: [{ productId: picked.id, quantity: Number(qty.value), unitPriceCents: picked.unitPrice ?? 0 }] }); toast('Sale recorded'); await load(mount, 'finance'); } catch (error) { toast(error.message ?? 'Could not record sale.', 'error'); } } }, field('Product', product), field('Quantity', qty), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Record sale')));
}

function createBusiness(mount) {
  if (!state.can('household.manage')) return empty({ title: 'Shia Baby is not set up', body: 'A household owner can create the business workspace.' }); const name = input({ value: 'Shia Baby', required: true }); const rate = input({ type: 'number', min: 0, max: 100, step: 0.1, value: 0, required: true });
  return card('Set up Shia Baby', null, h('form', { onSubmit: async (e) => { e.preventDefault(); try { await api.post(`/api/households/${state.household.id}/business`, { name: name.value.trim(), timezone: state.timezone, taxSetAsideRate: Number(rate.value) / 100 }); state.business = { name: name.value.trim() }; toast('Business workspace created'); await load(mount, 'overview'); } catch (error) { toast(error.message ?? 'Could not create business.', 'error'); } } }, field('Business name', name), field('Tax set-aside percentage', rate, { hint: 'An estimate only. Michel OS always shows the disclaimer with the number.' }), h('button', { class: 'btn btn--primary', type: 'submit' }, 'Create workspace')));
}

function scheduledHours(base, employeeId) { const value = base.hoursByEmployee?.[employeeId]; return typeof value === 'number' ? Math.round(value * 10) / 10 : null; }
function minuteValue(value) { const [hour, minute] = String(value).split(':').map(Number); return hour * 60 + minute; }
function minuteLabel(value) { const hour = Math.floor(value / 60); const minute = value % 60; const suffix = hour >= 12 ? 'PM' : 'AM'; const display = hour % 12 || 12; return `${display}:${String(minute).padStart(2, '0')} ${suffix}`; }
function weekdayLabel(value) { return ({ MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' })[value] ?? value; }
function metric(label, value) { return h('div', { class: 'card' }, h('p', { style: { color: 'var(--muted)', marginBottom: '.25rem' } }, label), h('p', { style: { fontSize: '1.4rem', fontWeight: 650, margin: 0 } }, String(value))); }
