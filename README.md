# MediOS AI - Hospital Management Backend API

Enterprise Clinical AI Workstation & Hospital SaaS REST API built with **NestJS**, **MongoDB (Mongoose)**, **JWT Authentication**, and **Swagger OpenAPI documentation**.

---

## 🚀 Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) v11
- **Runtime**: Node.js v24+
- **Database**: MongoDB with [Mongoose](https://mongoosejs.com/) v8
- **Authentication**: short-lived JWT access tokens (`@nestjs/jwt`, `passport-jwt`) + rotating refresh cookie, `bcryptjs`
- **Hardening**: `helmet`, `@nestjs/throttler` rate limits, role guard, env validation at boot
- **Documentation**: Swagger OpenAPI (`@nestjs/swagger`) at `/api/docs`
- **Validation**: `class-validator` & `class-transformer`

---

## 📁 Project Architecture

```
hospital-backend/
├── docker-compose.yml          # One-click MongoDB + Mongo Express container setup
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── main.ts                 # Bootstrap with Global Prefix (/api), CORS, Swagger & Pipes
│   ├── app.module.ts           # Root module with Global JWT Guard, Filter & Interceptor
│   ├── config/
│   │   └── configuration.ts    # ConfigService schema (Port, Mongo URI, JWT Secret)
│   ├── common/
│   │   ├── decorators/         # @Public(), @CurrentUser()
│   │   ├── guards/             # JwtAuthGuard, RolesGuard, ClientHeaderGuard (CSRF)
│   │   ├── filters/            # AllExceptionsFilter
│   │   └── interceptors/       # TransformInterceptor (standard envelope)
│   ├── database/
│   │   ├── seed.ts             # Demo hospital seeder (validates through the schemas)
│   │   └── seed-data/          # Seed fixtures, one JSON file per collection
│   └── modules/
│       ├── auth/               # Login, refresh/rotation, sessions, password change, register (/api/auth/*)
│       ├── users/              # Doctor & Staff accounts
│       ├── patients/           # Patient CRUD, search, conditions, allergies (/api/patients/*)
│       ├── appointments/       # Scheduling, live queue, status tracking (/api/appointments/*)
│       ├── consultations/      # SOAP notes, ICD-10 search, AI CDSS suggestions (/api/consultations/*)
│       ├── prescriptions/      # Digital Rx, drug interactions, alternatives (/api/prescriptions/*)
│       ├── medications/        # Reconciliation & adherence tracking (/api/medications/*)
│       ├── lab-reports/        # Parameters, abnormal findings, trends (/api/lab-reports/*)
│       ├── imaging/            # PACS/RIS DICOM studies & reports (/api/imaging/*)
│       ├── billing/            # Invoices, payments, revenue statistics (/api/billing/*)
│       ├── follow-ups/         # Patient recalls & automated reminders (/api/follow-ups/*)
│       ├── timeline/           # Longitudinal patient history (/api/timeline/*)
│       ├── documents/          # Medical records & digital signatures (/api/documents/*)
│       ├── vitals/             # Multi-parameter vitals logging & trends (/api/vitals/*)
│       ├── tasks-alerts/       # Clinical alert checklist & status toggle (/api/tasks-alerts/*)
│       ├── messages/           # Inter-departmental & patient chats (/api/messages/*)
│       ├── knowledge/          # Hospital SOPs & evidence guidelines (/api/knowledge/*)
│       ├── voice-to-notes/     # Ambient AI medical transcription & SOAP extraction (/api/voice-to-notes/*)
│       ├── dashboard/          # Aggregated KPIs, patient flow, live schedule (/api/dashboard/*)
│       ├── calls/              # AI call agent: confirmation & booking calls (/api/calls/*)
│       ├── queue/              # Check-in tokens, room calls, waiting-room displays (/api/queue/*)
│       ├── beds/               # Bed board, AI-assisted admit, transfer, discharge, housekeeping (/api/beds/*)
│       ├── ai/                 # Shared AI module: none / sample / claude providers (/api/ai/*)
│       └── settings/           # Hospital metadata, staff & AI configs (/api/settings/*)
```

---

## ⚡ Quick Start

### 1. Start MongoDB (via Docker)

```bash
docker compose up -d mongodb
```
*MongoDB will be running on `localhost:27017`.* The image is pinned to `mongo:8.2.12`: newer releases refuse to start on the Linux kernel current Docker Desktop VMs ship (SERVER-121912).
*(Optional) `docker compose up -d` also starts Mongo Express on `http://localhost:8081`.*

### 2. Configure Environment

Copy `.env.example` to `.env` and set a real `JWT_SECRET`:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # paste as JWT_SECRET
```

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — (required) | HS256 signing key, 32+ characters. The API refuses to start without one, with a short one, or with the old published demo secret |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Refresh cookie lifetime; each use rotates it |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated web origins; `*` is rejected |
| `COOKIE_SECURE` | `true` in production | `Secure` flag on the refresh cookie (HTTPS only) |
| `COOKIE_SAMESITE` | `lax` | Use `none` (with `COOKIE_SECURE=true`) when the web app is on another site |
| `MAX_FAILED_LOGINS` / `LOCKOUT_MINUTES` | `5` / `15` | Account lockout after repeated wrong passwords |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `TRUST_PROXY` | `false` | Set behind a reverse proxy so rate limits see client IPs |
| `SWAGGER_ENABLED` | off in production | Serve `/api/docs` |
| `PORT`, `MONGODB_URI`, `TZ` | `4000`, local Mongo, — | `TZ` decides what "today" means for record dates and the dashboard |
| `CLINIC_DATE` | unset | Development only: pins "today" to the seeded demo day (`2026-09-26`), like the web app's `VITE_CLINIC_DATE` |
| `CALL_PROVIDER` | `simulated` (dev), `none` (production) | AI call agent voice provider: `snapserve`, `simulated` (dev only, no phone rings) or `none` |
| `SNAPSERVE_API_KEY`, `SNAPSERVE_CONFIRMATION_AGENT_ID`, `SNAPSERVE_BOOKING_AGENT_ID` | — | Required with `CALL_PROVIDER=snapserve` |
| `CALL_WEBHOOK_SECRET` | — | Required with `snapserve` (24+ characters); authenticates the post-call webhook |
| `CALL_SCHEDULER_INTERVAL_SECONDS` | `60` | How often due calls are placed (0 = scheduler off) |

The default port is 4000 because macOS's AirPlay Receiver holds port 5000.

### 3. Seed Database with Initial Clinical Data

```bash
npm run seed
```

This replaces the demo collections with the fixtures in `src/database/seed-data/` — the records the web app was designed around, a clinic day on **26 Sep 2026**:
- Logins, all with password **`Admin@123`**: **`doctor@medios.ai`** (doctor), **`admin@medios.ai`** (admin, can create accounts), **`nurse@`**, **`frontdesk@`** (staff), **`pharmacy@`** (pharmacist) and **`lab@medios.ai`** (lab). Change these before any real use.
- 12 patients; **Arun Kumar** (`UHID: MHK202500321`) has the full chart: 8 consultations, prescription, medications, 8 lab reports, 6 imaging studies, 7 invoices, vitals history, timeline and documents
- The 26 Sep appointment queue plus six unconfirmed or confirmed appointments on 27–28 Sep for the AI call agent, follow-ups, 28 tasks & alerts, 10 message threads and workstation settings
- Queue tokens for everyone who has arrived on 26 Sep, numbered in arrival order, and three demo patient cards (display and kiosk links, and cards linked by hand, survive a reseed)

Records are inserted through the Mongoose schemas, so a fixture that breaks an enum or required field fails the seed.

### 4. Run Development Server

```bash
npm run start:dev
```

- API Base: `http://localhost:4000/api`
- Interactive Swagger UI: `http://localhost:4000/api/docs`

---

## 🔒 Authentication

**Sessions.** `POST /api/auth/login` returns a 15-minute access token and sets an httpOnly refresh cookie (`medios_rt`, path `/api/auth`, `SameSite=Lax`, `Secure` in production):

```json
{ "success": true, "statusCode": 200,
  "data": { "accessToken": "eyJhbGciOi...", "expiresIn": 900, "user": { "id": "...", "name": "Dr. Shajin", "role": "doctor" } } }
```

Send it as `Authorization: Bearer <accessToken>`. When it expires, `POST /api/auth/refresh` (cookie + `X-MediOS-Client` header) returns a new one and rotates the cookie. Browser clients should keep the access token in memory only.

**Native apps** (the CareSync mobile app) have no cookie jar to rely on. A request with `X-MediOS-Client: mobile` and no `Origin` header (browsers always send one on POST) gets `refreshToken` in the response body of `login`, `refresh` and `change-password`, and sends it back as `{ "refreshToken": "…" }` to `refresh` and `logout`. The app keeps it in the device's secure storage.

- **Access tokens** are HS256 JWTs with issuer, audience, `jti` and a token version. Other algorithms are rejected. Each request re-checks that the user is still active and that the version matches, so a password change or "sign out everywhere" revokes every outstanding token at once.
- **Refresh tokens** are random 384-bit values stored only as SHA-256 hashes, one row per device (`refreshtokens`, expired rows removed by a TTL index). Each refresh token is single-use. Presenting a used one again signals theft and revokes that device's whole token family.
- **CSRF.** Cookie-authenticated endpoints (`refresh`, `logout`) require the `X-MediOS-Client` header, which cross-site forms cannot send and CORS blocks cross-origin scripts from adding.
- **Passwords** are bcrypt (cost 12) and must be 8–72 characters with upper and lower case, a number and a symbol. Unknown emails take as long as wrong passwords and get the same message.
- **Brute force.** 5 wrong passwords lock the account for 15 minutes (`429`). Rate limits: sign-in 10/min, refresh 30/min, password change 5/min, everything else 300/min per IP.
- **Roles** (`doctor`, `nurse`, `pharmacist`, `lab`, `staff`, `admin`). Only admins create accounts. Only doctors sign documents, report imaging, write prescriptions and SOAP notes. Only admins delete patients. Admins and doctors delete appointments and change settings.
- **Also:** helmet headers, a strict CORS allow-list, 1 MB body limit, Swagger off in production, internal error messages hidden in production, and search input escaped before it reaches a regex.

---

## 📞 AI Call Agent

An AI voice agent phones patients for two jobs:

- **Confirmation:** "Will you be able to come on Sunday, 27 September at 10 AM?" The patient confirms, picks one of two alternative slots, or cancels. The appointment is updated to match.
- **Booking:** offers two free slots (on different days when possible) for a stated reason. If the patient picks one, the appointment is created and marked confirmed, and a linked follow-up is updated.

**How a call works**
1. A person (or the scheduler) asks for a call. The API checks the patient can be called (valid number, not do-not-call), fills the agent's script variables and records the call (`agentcalls` collection).
2. Inside calling hours (09:00–20:00 by default) it is placed at once; outside them it waits for the next window. One appointment never has two live calls (unique index).
3. The voice provider runs the conversation and reports the outcome and data fields (`chosen_slot`, `callback_time`, `notes`), summary and transcript.
4. The API applies the outcome once (duplicate webhooks are ignored) and records what it did:

| Outcome | What happens |
|---|---|
| Confirmed | Appointment marked `Confirmed` |
| Reschedule + chosen slot | Appointment moved to that slot (if still free) and confirmed |
| Reschedule, no slot / slot taken | `Reschedule Requested`; front-desk task created |
| Cancelled | Appointment `Canceled` (`Cancelled by Patient`); slot freed |
| Booked + chosen slot | Appointment created (`bookedVia: 'AI call'`, confirmed) |
| Call back later | A new booking call scheduled at the requested time |
| No answer / busy | Retry after 30, then 60 minutes (max 3 attempts, never within 2 h of the appointment); then `Unreachable` and a task |
| Wrong number / do not call | Patient flagged `doNotCall`; never called again until staff allow it |
| Needs staff (symptoms, asks for a person) | High-priority critical alert to call back |
| Anything unrecognised | Low-priority task to review the transcript; nothing changed |

**Scheduler.** With `autoConfirm` on (AI Call Agent → Automation), every unconfirmed appointment gets one call `confirmHoursBefore` (default 24) hours ahead. The scheduler also places due retries and callbacks, and gives up on calls whose result never arrived (30 minutes). Calls are claimed atomically, so several API instances can run it.

**Safety rules in the scripts** (`src/modules/calls/agent-scripts.ts`; served at `GET /api/calls/scripts`):
- the agent says it is an AI;
- it gives no medical advice, results, dosing or fees;
- symptoms or emergencies mean "call 108 / go to emergency" plus a staff alert;
- it discusses the appointment only with the patient, or a parent or guardian for under-18s;
- "stop" means it never calls again.

**Providers** (`CALL_PROVIDER`):
- `simulated` (development default): no phone rings. Outcomes come with a scripted transcript after a few seconds; choose the pretend patient's answer in the AI Call Agent screen. The API refuses to start with it in production.
- `snapserve`: real calls through [SnapServe AI](https://app.snapserve.ai) and the carrier attached to its agents (e.g. Vobiz). Steps:
  1. Create two agents from the scripts (the same variables, outcome labels and data fields).
  2. Set `SNAPSERVE_*` and `CALL_WEBHOOK_SECRET`.
  3. Give each agent the post-call notify URL `https://<api-host>/api/calls/webhook/snapserve?token=<CALL_WEBHOOK_SECRET>`.
  4. Make one test call and compare its webhook payload with `parseSnapServeResult`.

  The API never retries a failed start request on its own, because the call may have gone out anyway.
- `none` (production default): call endpoints answer 503.

Before using real calls, get patients' consent to automated calls and follow TRAI calling-hours and DND rules. Transcripts are health data: restrict who can read them.

---

## 🛏️ Beds and admissions

The `beds` module is the live bed board and the admit flow (admit, transfer, discharge, clean, block). A bed is `free`, `held`, `occupied`, `cleaning` or `blocked`, and one bed holds one patient: holding and occupying are single conditional updates, so two people racing for a bed get one success and one clear conflict error.

- **Rules decide, AI advises.** Fixed rules (free and cleaned, ward gender, room class, needed features such as oxygen or a monitor) remove beds that must not be used. The rest are ranked by preferences (room class match, nearness to the nurses' station and the department, step-up care). The AI sees only the top 5 and may reorder them and explain up to 3 in plain English (each reason at most 140 characters). If the AI is off, slow or answers badly, staff see the rule-based list and no error.
- **Bed hold.** A chosen bed is held for 5 minutes while the admission is confirmed; `DELETE /api/beds/:bedId/hold` gives it back.
- **Roles.** Board, stream, suggestions, hold, admit, transfer and discharge: admin, doctor, nurse, staff. Mark cleaned, block and unblock: admin, nurse, staff. Ignoring the rules (with a reason): admin and doctor. Pharmacist and lab have no access.
- **Routes** (all under `/api/beds`): `GET board`, `GET stream` (server-sent events: `changed` and `ping`), `POST suggestions`, `POST suggestions/:id/refine`, `GET :bedId/admission` (the admitted patient and their needs, for a transfer), `POST :bedId/hold`, `DELETE :bedId/hold`, `POST :bedId/admit`, `POST :bedId/transfer`, `POST :bedId/discharge` (body `{ admissionId }`, null for a sample occupant), `POST :bedId/clean`, `POST :bedId/block`, `POST :bedId/unblock`.
- **Privacy.** The AI never gets the patient's name, UHID, phone, address, email or any database id. Doctor's notes (at most 4,000 characters) are stripped of those details first, and beds go out as per-request tokens. Every suggestion, its AI output or failure, and the bed finally chosen is saved for later review.
- **Data.** `npm run seed` loads a demo layout of 11 wards and 138 beds. For the hospital's real layout, see the CSV import below.

---

## 🤖 AI

One shared AI module (`src/modules/ai`) runs structured requests for features such as bed suggestions. `AI_PROVIDER` picks the mode:

- `sample` (development default): canned answers; no AI service is called.
- `claude`: real answers from Anthropic. Needs `ANTHROPIC_API_KEY`; `AI_MODEL` defaults to `claude-opus-5-5` and `AI_TIMEOUT_MS` (milliseconds to wait for the AI before using the rules) to 8000.
- `none` (production default): AI is off.

The API key lives only in `.env` (never commit it). Each feature also has an on/off switch in Settings (`ai.bedSuggestions`). `GET /api/ai/status` shows the active mode; `POST /api/ai/check` (admin) tests the connection. If the AI is off, slow or answers badly, features fall back to their rules.

---

## 🛏️ Importing the hospital's real beds

The demo seed loads a made-up 138-bed layout. To load the hospital's real wards and beds, fill in a CSV (start from `docs/beds-import-template.csv`; one row per bed) and run:

```bash
MONGODB_URI=... npm run import-beds -- path/to/beds.csv
```

- Columns: `ward_code, ward_name, ward_short_name, floor, ward_type, gender, rate_per_day, near_departments, bed_number, bed_label, room, features`. `near_departments` and `features` are separated by `;`; wrap a value that contains a comma in double quotes. `bed_label` may be left empty and `room` is only for beds that share a room.
- `ward_type`: emergency, icu, hdu, isolation, general, paediatric, maternity, twin, private or deluxe. `gender`: male, female or any. Features: oxygen, monitor, ventilator, nearNurses, singleRoom, attendantBed.
- Rows of one ward must repeat the same ward details. Wards show on the board in the order they first appear in the file.
- Every imported bed starts free. The script prints every problem it finds (`Row N: ...`, N counting data rows without the header) and changes nothing if there are any.
- It refuses to run while any bed is occupied or held (`Beds are in use (N occupied or held)...`), and also while any admission or bed-suggestion record exists (`Admission history exists (A admissions, S bed suggestions)...`); it changes nothing in either case. `--force` replaces the wards and beds anyway and also deletes all admissions and bed suggestions, because they point at the old beds.
- It prints the database host (never the full address). Like `npm run seed`, it does not read `.env`: set `MONGODB_URI` on the command line.

---

## 🎫 Token Queue

Check-in gives the patient a numbered token for the day. Staff call tokens to a room, and a waiting-room screen shows who is being served and who is next. The module lives in `src/modules/queue`.

**Tokens.** `POST /api/queue/tokens` takes a UHID or today's appointment.
- Numbers restart each clinic day. A per-day counter is incremented atomically. The `queue.tokenPrefix` setting gives labels like `A12`.
- A patient holds at most one live token a day (unique `activeKey`). Checking in again returns the same token, and a skipped token rejoins the queue. A repeated check-in or card tap is therefore harmless.
- Given only a UHID, the API links the patient's next open appointment today; with none, the token is a walk-in. Unregistered UHIDs are refused.

**Calling.** Tokens go waiting → called → completed. A called patient who does not come is *skipped* and can be put back, keeping their number.
- Serving order: priority tokens first, then by number.
- `POST /api/queue/next` completes the room's current token, then calls the next one. While the room has a token, the request must name it in `finish`, so a double press cannot skip a patient. A room has at most one called token (unique partial index), so two simultaneous presses cannot both call someone.
- The linked appointment follows the token: Checked In → In Consultation → Completed (back to Checked In on a skip). Completing or cancelling the appointment through the appointments API ends its token too.
- Rooms, the prefix and what the display shows are in the `queue` settings section (`PUT /api/settings`).

**Displays.** A display is a screen allowed to show the queue without a staff sign-in.
- An admin or doctor adds one (`POST /api/queue/displays`) and gets a random key once. Only its SHA-256 is stored. Removing the display revokes the key.
- The display authenticates with `Authorization: Display <key>`. It reads `GET /api/queue/display/stream` (server-sent events: a snapshot on every change and every 15 s), or `GET /api/queue/display/state` when it cannot stream.
- A snapshot holds token labels, rooms and counts, plus short names ("Priya S.") only when `showNamesOnDisplay` is on. It never carries UHIDs, full names or appointment details.
- Change notifications are in-process. With several API instances, a display connected to another instance catches up within 15 s. Behind nginx, the stream sets `X-Accel-Buffering: no`; other proxies must not buffer `text/event-stream`.

**Cards and check-in kiosks.** Patients can check themselves in by tapping a basic NFC card (NTAG or MIFARE Classic) on a USB reader.
- Nothing is written to the card. The reader types the card's factory serial number like a keyboard, and the API links that number to a UHID (`patientcards` collection; `POST /api/queue/cards`). Separators and letter case are normalised (`04:a1:b2:c3` = `04A1B2C3`).
- Use the same reader model and settings at the desk and the kiosk: a reader set to decimal output types a different number for the same card than one set to hex.
- A card already linked to another patient is refused unless `reassign` is sent.
- A basic card's serial can be copied, so a tap only gets a queue token for that patient. It never opens a record.
- A **kiosk** is a device like a display, with `kind: 'kiosk'`, its own key prefix (`mqk_`) and `Authorization: Kiosk <key>`. Its tap (`POST /api/queue/kiosk/tap`) issues or returns the token, like any check-in. The answer has the token, a short name ("David R."), how many are ahead, and the room if already called. It never carries the UHID or full name.
- `printSlips` per kiosk: the kiosk prints an 80 mm slip after each new token. The tap response carries the current value, so switching it applies from the next tap.
- Taps at the front desk use `POST /api/queue/cards/tap` with a staff session. An unknown card answers 404, and the web app then offers to link it.
- The seed links three demo cards: `04A1B2C3` (Rekha S), `0004567890` (David Raj) and `04C8D9E0F1A2B3` (Selvi A). Cards linked by hand survive a reseed.

---

## 🧪 Tests

```bash
docker start medios-mongodb   # the database specs need MongoDB running
npm test                      # every src/**/*.spec.ts, using Node's built-in runner
npm run test:file -- src/modules/beds/rules.spec.ts   # one file
npx tsc --noEmit -p tsconfig.json                      # type-checks the specs too
```

Specs that touch the database use `medios_test` only, never your working database.

---

## 📐 API Conventions

- Every record is returned with a string `id` (no `_id`/`__v`); password hashes are never serialized.
- Clinical facts have no defaults. Vitals, blood group, insurance, lab result status, radiology reports and evidence grades are absent until recorded; new invoices start `Unpaid`, documents `Draft`, imaging studies `Pending`.
- Author fields (`doctor`, `createdBy`, `author`, `recordedBy`, `assignedTo`, `reportedBy`) default to the signed-in user.
- Record dates default to "now" in the record's display format (`26 Sep 2026`, `09:30 AM`); appointments use ISO days (`2026-09-26`).
- Endpoints that summarise a day (`/dashboard/stats`, `/appointments/today`, `/billing/stats`) take `?date=YYYY-MM-DD`, defaulting to today.
- Validation failures return `400`, duplicate keys `409`.
- `POST /follow-ups/:id/send-reminder` reports `sent: false`: no SMS/WhatsApp provider is integrated yet. The AI endpoints (`ai-suggestions`, `ask-ai`, `voice-to-notes`) still return canned demo text.

---

## 📋 Comprehensive API Route Catalog

| Module | Method | Endpoint | Description |
|---|---|---|---|
| **Auth** | `POST` | `/api/auth/login` | Sign in: access token + refresh cookie |
| | `POST` | `/api/auth/refresh` | New access token from the refresh cookie (rotates it) |
| | `POST` | `/api/auth/logout` | Sign out this device |
| | `POST` | `/api/auth/logout-all` | Sign out every device, revoke all tokens |
| | `GET` | `/api/auth/sessions` | Your signed-in devices |
| | `DELETE` | `/api/auth/sessions/:id` | Sign one device out |
| | `POST` | `/api/auth/change-password` | Change password; other devices are signed out |
| | `POST` | `/api/auth/register` | Create a staff account (admin only) |
| | `GET` | `/api/auth/me` | Current authenticated user profile |
| **Dashboard** | `GET` | `/api/dashboard/stats?date=` | A day's counts, schedule, patient flow, visit types, critical alerts and recent patients |
| **Patients** | `GET` | `/api/patients` | Search & filter patients by status, visitType, department |
| | `GET` | `/api/patients/:idOrUhid` | Get patient record by MongoDB ID or UHID |
| | `POST` | `/api/patients` | Register a new patient |
| | `PUT` | `/api/patients/:idOrUhid` | Update patient record |
| | `DELETE` | `/api/patients/:idOrUhid` | Delete patient |
| **Appointments**| `GET` | `/api/appointments` | Filter appointments by date, status, uhid |
| | `GET` | `/api/appointments/today`| Live today's appointment queue |
| | `POST` | `/api/appointments` | Book new appointment |
| | `PATCH` | `/api/appointments/:id/status` | Update status (Checked In, In Consultation, Completed) |
| **Consultations**| `GET` | `/api/consultations?uhid=...` | Past consultations for patient |
| | `GET` | `/api/consultations/soap/:uhid` | Latest active SOAP note |
| | `POST` | `/api/consultations/soap` | Save / update SOAP clinical note |
| | `GET` | `/api/consultations/icd10?q=...` | Search ICD-10 diagnostic codes |
| | `POST` | `/api/consultations/ai-suggestions` | AI Clinical Decision Support (CDSS) |
| **Prescriptions**| `GET` | `/api/prescriptions?uhid=...` | Patient prescriptions history |
| | `POST` | `/api/prescriptions` | Create new prescription |
| | `POST` | `/api/prescriptions/check-interactions` | Check drug-drug interactions |
| | `GET` | `/api/prescriptions/alternatives/:medicine` | Drug alternatives & generics |
| **Medications**| `GET` | `/api/medications?uhid=...` | Medication reconciliation list |
| | `PATCH` | `/api/medications/:id/status` | Set status (Active, Paused, Stopped, Completed) |
| | `GET` | `/api/medications/adherence/:uhid` | Adherence score over measured medications (null when none) |
| **Lab Reports** | `GET` | `/api/lab-reports?uhid=...` | Investigation reports |
| | `GET` | `/api/lab-reports/trends/:uhid` | Per-parameter series built from the patient's own reports |
| **Imaging** | `GET` | `/api/imaging?uhid=...` | Radiological studies (X-Ray, CT, MRI, USG) |
| | `PATCH` | `/api/imaging/:id/report` | Radiologist report submission |
| **Billing** | `GET` | `/api/billing/invoices` | List invoices by patient or status |
| | `POST` | `/api/billing/invoices` | Generate new invoice |
| | `PATCH` | `/api/billing/invoices/:id/pay` | Record invoice payment |
| | `GET` | `/api/billing/stats` | Today's revenue & receivables stats |
| **Follow-ups** | `GET` | `/api/follow-ups` | Recall schedule list |
| | `PATCH` | `/api/follow-ups/:id/status` | Update recall status |
| | `POST` | `/api/follow-ups/:id/send-reminder` | Recall reminder (not sent until an SMS/WhatsApp provider is added) |
| **Timeline** | `GET` | `/api/timeline/:uhid` | Full longitudinal chronological record |
| **Documents** | `GET` | `/api/documents?uhid=...` | Discharge summaries, consent forms, etc. |
| | `PATCH` | `/api/documents/:id/sign` | Digitally sign document |
| **Vitals** | `GET` | `/api/vitals/:uhid` | Multi-parameter vitals history & ranges |
| | `POST` | `/api/vitals` | Log new vital signs |
| **Tasks & Alerts**| `GET` | `/api/tasks-alerts` | Clinical task & alert list |
| | `PATCH` | `/api/tasks-alerts/:id/toggle` | Toggle Pending / Completed |
| **Messages** | `GET` | `/api/messages/threads` | Pharmacy, Lab, Nursing & Patient chats |
| | `POST` | `/api/messages/threads/:id/send`| Send message in thread |
| **Knowledge** | `GET` | `/api/knowledge/articles` | Hospital SOPs and protocols |
| | `GET` | `/api/knowledge/guidelines` | Evidence clinical guidelines |
| | `POST` | `/api/knowledge/ask-ai` | AI Q&A cited against guidelines |
| **Voice Ambient**| `POST` | `/api/voice-to-notes/transcribe` | Diarized speech-to-text transcript |
| | `POST` | `/api/voice-to-notes/generate-soap` | Convert speech transcript into structured SOAP |
| **AI Call Agent** | `GET` | `/api/calls` | Call log (filters: purpose, status, outcome, uhid, appointmentId) |
| | `GET` | `/api/calls/:id` | One call with transcript |
| | `GET` | `/api/calls/stats` | Today's call counts, unconfirmed and needs-attention appointments |
| | `GET` | `/api/calls/config` | Active provider and effective agent settings |
| | `GET` | `/api/calls/scripts` | Agent scripts, outcomes and data fields |
| | `GET` | `/api/calls/slots?from=` | Free slots the booking agent would offer |
| | `POST` | `/api/calls/confirmation` | Confirmation call for a scheduled appointment |
| | `POST` | `/api/calls/booking` | Booking call for a patient (optional follow-up link) |
| | `POST` | `/api/calls/:id/cancel` | Withdraw a call not yet placed |
| | `POST` | `/api/calls/run-due` | Run the scheduler now (admin, doctor) |
| | `DELETE` | `/api/calls/do-not-call/:uhid` | Allow calls to a patient again (admin, doctor) |
| | `POST` | `/api/calls/webhook/snapserve?token=` | Provider post-call webhook (no user token) |
| **Token Queue** | `GET` | `/api/queue?date=` | A day's tokens with places in line, counts and queue settings |
| | `POST` | `/api/queue/tokens` | Check in and issue today's token (UHID or appointmentId; returns an existing one) |
| | `POST` | `/api/queue/next` | Finish the room's current token and call the next |
| | `POST` | `/api/queue/tokens/:id/call` | Call a waiting or skipped token out of turn |
| | `POST` | `/api/queue/tokens/:id/recall` | Announce a called token again |
| | `POST` | `/api/queue/tokens/:id/skip` | Called patient did not come |
| | `POST` | `/api/queue/tokens/:id/requeue` | Put a skipped token back |
| | `POST` | `/api/queue/tokens/:id/complete` | Doctor finished with the token |
| | `POST` | `/api/queue/tokens/:id/cancel` | Withdraw a waiting or skipped token |
| | `GET` `POST` `PATCH` `DELETE` | `/api/queue/displays[/:id]` | Manage displays and kiosks; `PATCH` renames or switches slip printing (admin, doctor) |
| | `GET` | `/api/queue/display/state` · `/stream` | What a display shows (`Authorization: Display <key>`, no user token) |
| | `GET` `POST` `DELETE` | `/api/queue/cards[/:id]` | A patient's cards (`?uhid=`), link a card, unlink a lost one |
| | `POST` | `/api/queue/cards/tap` | Card tapped at the front desk: issue or return its token (404 if unknown) |
| | `GET` | `/api/queue/kiosk/state` | Kiosk name, slip printing, hospital name (`Authorization: Kiosk <key>`) |
| | `POST` | `/api/queue/kiosk/tap` | Card tapped at a kiosk: token, short name, people ahead (`Authorization: Kiosk <key>`) |
| **Settings** | `GET` | `/api/settings` | Hospital profile, staff, and AI settings |
| | `PUT` | `/api/settings` | Update settings and preferences |
