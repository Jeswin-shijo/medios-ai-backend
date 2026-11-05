// End-to-end check of every reception-kiosk path against a running API (sample providers).
// Usage: API=http://localhost:4500/api node scripts/e2e-reception.mjs
const API = (process.env.API || 'http://localhost:4500/api').replace(/\/+$/, '');
const CLIENT = { 'X-MediOS-Client': 'mobile' };
const LABEL = /^[A-Z][A-Z0-9]{0,2}-\d{3}$/;

let passed = 0;
let failed = 0;
let adminToken = '';
let kioskKey = '';
let kioskId = '';
let displayKey = '';
let displayId = '';
let doctor = null;
let doctorBody = null;
let clinicDay = '';

async function call(method, path, { body, auth, headers } = {}) {
  const h = { ...CLIENT, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth === 'admin') h.Authorization = `Bearer ${adminToken}`;
  else if (auth === 'kiosk') h.Authorization = `Kiosk ${kioskKey}`;
  else if (auth) h.Authorization = auth;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  const data = json && typeof json === 'object' && 'data' in json && 'success' in json ? json.data : json;
  return { status: res.status, data, json };
}

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`✔ ${name}`); }
  else { failed++; console.log(`✘ ${name}${detail === undefined ? '' : `\n    ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); }
  return !!cond;
}

/** Expects success; throws a readable error otherwise so the dependent steps stop. */
async function must(label, p) {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.data;
}

const errCode = (r) => r.json?.code ?? r.json?.data?.code ?? r.json?.error?.code ?? r.data?.code;
const kiosk = (m, p, body) => call(m, p, { auth: 'kiosk', body });
const admin = (m, p, body) => call(m, p, { auth: 'admin', body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollPaid(visitId, tries = 20) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = (await kiosk('GET', `/reception/kiosk/visits/${visitId}`)).data;
    if (v?.status === 'paid' && v.opNumber && v.token && v.billNumber) return v;
    await sleep(250);
  }
  return v;
}

/** Books an appointment today with the test doctor, at the first free time of the day (each slot is taken once). */
async function bookToday(patient) {
  const start = Math.floor(Math.random() * 96);
  for (let i = 0; i < 96; i++) {
    const minutes = ((start + i) % 96) * 15;
    const h = Math.floor(minutes / 60);
    const time = `${String(h % 12 || 12).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    const r = await admin('POST', '/appointments', {
      uhid: patient.uhid, patientName: patient.name, age: patient.age, gender: patient.gender, date: clinicDay, time,
      type: 'Consultation', condition: 'E2E check', status: 'Scheduled', doctorId: doctor.id, doctorName: doctor.name, departmentCode: doctor.departmentCode,
    });
    if (r.status === 409) continue;
    if (r.status >= 300) throw new Error(`book an appointment failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.data.id ?? r.data._id;
  }
  throw new Error('the test doctor has no free time today');
}

/**
 * The Revenue Agent has the paid visit (R26): one consultation line (the appointment's own check-in charge, or the visit's),
 * the kiosk payment for the fee, and nothing due. `appointmentId` set: the visit checked that appointment in.
 */
async function checkRevenue(paid, appointmentId) {
  // Revenue's own check-in hook runs on its own; give it time to (wrongly) add a second line.
  if (appointmentId) await sleep(1000);
  const found = await must('find the bill', admin('GET', `/revenue/bills?q=${encodeURIComponent(paid?.billNumber ?? '')}`));
  const row = (found ?? []).find((b) => b.number === paid?.billNumber);
  if (!ok('the visit is on a Revenue bill', !!row, paid?.billNumber)) return;
  const view = await must('open the bill', admin('GET', `/revenue/bills/${row._id}`));
  const consult = view.lines.filter((l) => l.category === 'consultation');
  const own = appointmentId ? { type: 'opd-fee', ref: appointmentId } : { type: 'op-visit', ref: paid.id };
  ok(`one consultation line, ${own.type === 'opd-fee' ? "the appointment's check-in charge" : "the visit's own"}`,
    consult.length === 1 && consult[0].source.type === own.type && consult[0].source.ref === own.ref && consult[0].amount === 300, consult);
  ok(`bill kind is ${appointmentId ? 'opd' : 'walk-in'}`, view.bill.kind === (appointmentId ? 'opd' : 'walk-in') && (!appointmentId || String(view.bill.appointment) === appointmentId), view.bill.kind);
  const kioskPay = view.payments.filter((p) => p.source === `op-visit:${paid.id}`);
  ok('one kiosk payment of 300 with its receipt', kioskPay.length === 1 && kioskPay[0].mode === 'kiosk' && kioskPay[0].amount === 300 && kioskPay[0].receiptNumber === paid.receiptNumber, kioskPay);
  ok('balance 0', view.bill.totals.balance === 0, view.bill.totals);
  return kioskPay[0];
}

async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (err) { ok(`${title}: ${err.message}`, false); }
}

async function setup() {
  const login = await call('POST', '/auth/login', { body: { email: 'admin@medios.ai', password: 'Admin@123' } });
  if (login.status >= 300) throw new Error(`admin login failed: ${login.status}`);
  adminToken = login.data.accessToken;
  const d = await must('create kiosk', admin('POST', '/queue/displays', { name: 'E2E kiosk', kind: 'kiosk' }));
  kioskKey = d.key; kioskId = d.display.id;
  const w = await must('create display', admin('POST', '/queue/displays', { name: 'E2E display', kind: 'display' }));
  displayId = w.display.id; displayKey = w.key;

  // Demo doctors can be off duty (evening runs), so the run uses its own all-day doctor.
  const body = {
    name: 'Dr. E2E Test', departmentCode: 'gen-med', qualifications: 'MBBS', fee: 300, room: 'Consultation Room', tokenPrefix: 'T',
    avgConsultMinutes: 10, sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }],
  };
  doctorBody = body;
  const existing = (await must('list doctors', admin('GET', '/opd/doctors'))).find((x) => x.name === body.name);
  if (existing) {
    doctor = await must('reactivate test doctor', admin('PATCH', `/opd/doctors/${existing.id ?? existing._id}`, { ...body, active: true }));
  } else {
    doctor = await must('create test doctor', admin('POST', '/opd/doctors', body));
  }
  doctor.id = doctor.id ?? doctor._id;
  clinicDay = (await must('kiosk config', kiosk('GET', '/reception/kiosk/config'))).clinic.date;
}

async function main() {
  await setup();
  console.log(`API ${API}, kiosk and display created, test doctor ${doctor.name}`);

  let step1Token = '';
  const rekha = { uhid: 'MHK202500324' };

  await section('1. Card path with UPI, checking in an appointment with that doctor', async () => {
    const id = await kiosk('POST', '/reception/kiosk/identify/card', { cardId: '04:a1:b2:c3' });
    ok('card tap finds Rekha S', id.status === 200 && id.data.patient?.uhid === rekha.uhid, id.json);
    ok('phone is masked', /^•{5} \d{5}$/.test(id.data.patient?.phone ?? ''), id.data.patient?.phone);
    const session = id.data.session;
    const docs = await kiosk('GET', '/reception/kiosk/doctors?department=gen-med');
    const listed = (docs.data || []).find((d) => d.id === doctor.id);
    ok('test doctor is listed and bookable', !!listed && listed.availability?.bookable === true, listed);
    const v = await kiosk('POST', '/reception/kiosk/visits', { session, doctorId: doctor.id });
    ok('visit started awaiting payment', v.status === 201 && v.data.status === 'awaiting-payment', v.json);
    const appointmentId = await bookToday(id.data.patient);
    const pay = await kiosk('POST', `/reception/kiosk/visits/${v.data.id}/pay`, { method: 'UPI' });
    ok('UPI payment has am=300.00', pay.status === 200 && /am=300\.00/.test(pay.data.upiUri ?? ''), pay.data?.upiUri);
    const done = await kiosk('POST', `/reception/kiosk/visits/${v.data.id}/sample-complete`);
    ok('sample payment completes', done.status === 200, done.json);
    const paid = await pollPaid(v.data.id);
    ok('visit is paid', paid?.status === 'paid', paid?.status);
    ok('OP number', /^OP-20260926-\d{4}$/.test(paid?.opNumber ?? ''), paid?.opNumber);
    ok('token label', LABEL.test(paid?.token?.label ?? ''), paid?.token?.label);
    ok('track link', (paid?.token?.trackUrl ?? '').includes('/track#'), paid?.token?.trackUrl);
    ok('bill and receipt numbers on the visit', /^BL-\d{4,}$/.test(paid?.billNumber ?? '') && /^RC-\d{4,}$/.test(paid?.receiptNumber ?? ''), { bill: paid?.billNumber, receipt: paid?.receiptNumber });
    const appt = await admin('GET', `/appointments/${appointmentId}`);
    ok('the appointment with that doctor is Checked In', appt.data?.status === 'Checked In', appt.data?.status);
    const kioskPay = await checkRevenue(paid, appointmentId);
    ok('the payment names UPI and SAMPLE', /^UPI · .+ · SAMPLE$/.test(kioskPay?.reference ?? ''), kioskPay?.reference);
    step1Token = paid?.token?.label;
    const track = await call('GET', `/queue/track/${paid?.token?.trackCode}`);
    ok('public tracking page has no patient name', track.status === 200 && !('patientName' in (track.data ?? {})) && !JSON.stringify(track.data).includes('Rekha'), track.data);
  });

  await section('2. Same patient again', async () => {
    const id = await kiosk('POST', '/reception/kiosk/identify/card', { cardId: '04A1B2C3' });
    ok('card tap shows the active token', id.data.activeToken?.label === step1Token, id.data.activeToken);
    const v = await kiosk('POST', '/reception/kiosk/visits', { session: id.data.session, doctorId: doctor.id });
    ok('second visit refused with 409 HAS_TOKEN', v.status === 409 && errCode(v) === 'HAS_TOKEN', v.json);
  });

  let otpToken = '';
  await section('3. OTP path with cash, checking in an appointment with that doctor', async () => {
    const pts = await must('list patients', admin('GET', '/patients?limit=100'));
    const list = Array.isArray(pts) ? pts : pts.patients ?? pts.items ?? pts.data ?? [];
    const digits = (p) => String(p.phone ?? '').replace(/\D/g, '').slice(-10);
    const candidates = list.filter((p) => p.uhid !== rekha.uhid && digits(p).length === 10);
    let picked = null; let visit = null; let summary = null;
    for (const p of candidates.slice(0, 8)) {
      const phone = digits(p);
      const sent = await kiosk('POST', '/reception/kiosk/otp/send', { phone });
      if (sent.status !== 200 || !sent.data.sampleCode) continue;
      const ver = await kiosk('POST', '/reception/kiosk/otp/verify', { phone, code: sent.data.sampleCode });
      if (ver.status !== 200) continue;
      const mine = ver.data.patients.find((x) => x.patient.uhid === p.uhid);
      if (!mine) continue;
      const v = await kiosk('POST', '/reception/kiosk/visits', { session: mine.session, doctorId: doctor.id });
      if (v.status === 201) { picked = p; visit = v.data; summary = mine.patient; ok('code sent and verified for a seeded patient', true); break; }
    }
    if (!picked) throw new Error('no seeded patient without a token was found');
    const appointmentId = await bookToday(summary);
    const cash = await kiosk('POST', `/reception/kiosk/visits/${visit.id}/pay`, { method: 'CASH' });
    ok('cash choice gives a payment code', cash.status === 200 && /^\d{4}$/.test(cash.data.paymentCode ?? ''), cash.json);
    const wait = await admin('GET', '/reception/visits?status=awaiting-cash');
    ok('staff list shows the cash visit', Array.isArray(wait.data) && wait.data.some((x) => x.id === visit.id), wait.status);
    const conf = await admin('POST', `/reception/visits/${visit.id}/confirm-cash`);
    ok('staff confirm cash', conf.status === 200, conf.json);
    const paid = await pollPaid(visit.id);
    ok('kiosk sees paid with a token', paid?.status === 'paid' && LABEL.test(paid?.token?.label ?? ''), paid);
    otpToken = paid?.token?.label;
    const appt = await admin('GET', `/appointments/${appointmentId}`);
    ok('the appointment with that doctor is Checked In', appt.data?.status === 'Checked In', appt.data?.status);
    const pay = await checkRevenue(paid, appointmentId);
    ok('the payment says cash at the counter', pay?.reference === 'Cash at counter', pay?.reference);
    const old = await admin('GET', `/billing/invoices?uhid=${picked.uhid}`);
    const olds = Array.isArray(old.data) ? old.data : [];
    ok('no old invoice is written for the visit', !olds.some((i) => JSON.stringify(i).includes(paid?.opNumber ?? '\u0000')), olds.length);
  });

  let newToken = '';
  await section('4. New patient with card payment (a walk-in)', async () => {
    const suffix = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
    const reg = await kiosk('POST', '/reception/kiosk/register', { name: `E2E Patient ${suffix}`, phone: `90000${suffix}`, gender: 'Female', age: 31 });
    ok('registered at the kiosk', (reg.status === 200 || reg.status === 201) && !!reg.data.patient?.uhid, reg.json);
    const v = await kiosk('POST', '/reception/kiosk/visits', { session: reg.data.session, doctorId: doctor.id });
    ok('visit started', v.status === 201, v.json);
    const pay = await kiosk('POST', `/reception/kiosk/visits/${v.data.id}/pay`, { method: 'CARD' });
    ok('card payment chosen', pay.status === 200, pay.json);
    ok('sample payment completes', (await kiosk('POST', `/reception/kiosk/visits/${v.data.id}/sample-complete`)).status === 200);
    const paid = await pollPaid(v.data.id);
    ok('visit is paid with a token', paid?.status === 'paid' && LABEL.test(paid?.token?.label ?? ''), paid?.status);
    newToken = paid?.token?.label;
    const kioskPay = await checkRevenue(paid);
    ok('the payment names the card and SAMPLE', /^Card · .+ · SAMPLE$/.test(kioskPay?.reference ?? ''), kioskPay?.reference);
  });

  await section('5. Cancelling', async () => {
    const mk = async (method) => {
      const suffix = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
      const reg = await kiosk('POST', '/reception/kiosk/register', { name: `E2E Cancel ${suffix}`, phone: `90001${suffix}`, gender: 'Male', age: 40 });
      const v = await kiosk('POST', `/reception/kiosk/visits`, { session: reg.data.session, doctorId: doctor.id });
      await kiosk('POST', `/reception/kiosk/visits/${v.data.id}/pay`, { method });
      return v.data.id;
    };
    const upi = await mk('UPI');
    const c1 = await kiosk('POST', `/reception/kiosk/visits/${upi}/cancel`);
    ok('kiosk cancels a UPI visit', c1.status === 200 && c1.data.status === 'cancelled', c1.json);
    const cash = await mk('CASH');
    const c2 = await kiosk('POST', `/reception/kiosk/visits/${cash}/cancel`);
    const after = (await kiosk('GET', `/reception/kiosk/visits/${cash}`)).data;
    ok('kiosk cannot cancel a cash visit', after?.status === 'awaiting-payment', { status: c2.status, after: after?.status });
    const c3 = await admin('POST', `/reception/visits/${cash}/cancel`);
    ok('staff cancels the cash visit', c3.status === 200 && c3.data.status === 'cancelled', c3.json);
  });

  await section('6. Refusals', async () => {
    const u = await kiosk('POST', '/reception/kiosk/identify/card', { cardId: 'FFEEDDCC' });
    ok('unknown card gives 404 CARD_UNKNOWN', u.status === 404 && errCode(u) === 'CARD_UNKNOWN', u.json);
    const p = await kiosk('POST', '/reception/kiosk/otp/send', { phone: '9111100000' });
    ok('unknown phone gives found:false', p.status === 200 && p.data.found === false, p.json);
    const s = await kiosk('POST', '/reception/kiosk/visits', { session: 'not-a-session', doctorId: doctor.id });
    ok('bad session gives 401 SESSION_ENDED', s.status === 401 && errCode(s) === 'SESSION_ENDED', s.json);
    const k = await call('GET', '/reception/kiosk/config', { auth: 'Kiosk wrong-key' });
    ok('wrong kiosk key gives 401 KIOSK_REVOKED, in the words tablets match', k.status === 401 && errCode(k) === 'KIOSK_REVOKED' && /kiosk (key|link)/i.test(k.json?.message ?? ''), k.json);
  });

  await section('7. Waiting-room display', async () => {
    const snap = await call('GET', '/queue/display/state', { auth: `Display ${displayKey}` });
    const upcoming = snap.data?.upcoming ?? [];
    for (const [name, label] of [['Rekha S', step1Token], ['OTP patient', otpToken], ['new patient', newToken]]) {
      const row = upcoming.find((t) => t.label === label);
      ok(`display lists the ${name} token ${label} with its room`, !!row && !!row.room, row ?? label);
    }
  });
}

async function cleanup() {
  const steps = [];
  if (doctor) steps.push(// The full body is sent: a PATCH with only `active` currently fails room validation (see the task report).
    admin('PATCH', `/opd/doctors/${doctor.id}`, { ...doctorBody, active: false }).then((r) => ok('test doctor deactivated', r.status === 200, r.json)));
  if (kioskId) steps.push(admin('DELETE', `/queue/displays/${kioskId}`).then((r) => ok('e2e kiosk removed', r.status < 300, r.json)));
  if (displayId) steps.push(admin('DELETE', `/queue/displays/${displayId}`).then((r) => ok('e2e display removed', r.status < 300, r.json)));
  await Promise.all(steps);
}

console.log('Reception kiosk end-to-end');
try { await main(); } catch (err) { ok(`setup: ${err.message}`, false); }
console.log('\n8. Cleanup');
try { await cleanup(); } catch (err) { ok(`cleanup: ${err.message}`, false); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
