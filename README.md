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
│       ├── beds/               # Bed board, Bed Agent requests, hand assign, transfer, discharge, housekeeping (/api/beds/*)
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
| `MONGODB_URI` | required | The database's `mongodb://` or `mongodb+srv://` address; the API refuses to start without it (it never falls back to a local database) |
| `PORT`, `TZ` | `4000`, — | `TZ` decides what "today" means for record dates and the dashboard |
| `CLINIC_DATE` | unset | Development only: pins "today" to the seeded demo day (`2026-09-26`), like the web app's `VITE_CLINIC_DATE` |
| `CALL_PROVIDER` | `simulated` (dev), `none` (production) | AI call agent voice provider: `snapserve`, `simulated` (dev only, no phone rings) or `none` |
| `SNAPSERVE_API_KEY`, `SNAPSERVE_CONFIRMATION_AGENT_ID`, `SNAPSERVE_BOOKING_AGENT_ID` | — | Required with `CALL_PROVIDER=snapserve` |
| `SNAPSERVE_INBOUND_AGENT_ID` | — | The agent on the hospital's number; its call results are logged as inbound calls |
| `CALL_WEBHOOK_SECRET` | — | Required with `snapserve` (24+ characters); authenticates the post-call webhook, sent in the `X-MediOS-Webhook-Token` header or as `?token=` |
| `CALL_ALLOWED_NUMBERS` | — | Testing real calls: comma-separated numbers; when set, no other number is ever dialled |
| `CALL_TOOLS_SECRET` | — | 24+ characters; turns on the inbound agent's mid-call tools (only while `CALL_PROVIDER` is `snapserve`, or `simulated` in development), which must send it as `X-Webhook-Secret` |
| `SNAPSERVE_SIGNING_SECRET` | — | Optional: when set, post-call webhooks must also carry a valid `X-SnapServe-Signature` |
| `CALL_SCHEDULER_INTERVAL_SECONDS` | `60` | How often due calls are placed (0 = scheduler off) |
| `PAYMENT_PROVIDER` | `sample` (dev), `none` (production) | Reception kiosk payments: `sample` (simulated, marked SAMPLE) or `none` |
| `SMS_PROVIDER` | `sample` (dev), `none` (production) | Reception kiosk OTP and tracking messages: `sample` or `none` |
| `PUBLIC_WEB_URL` | unset | Base address of the web app, used for the public `/track` links (http or https) |

The default port is 4000 because macOS's AirPlay Receiver holds port 5000.

### 3. Seed Database with Initial Clinical Data

```bash
npm run seed
```

The seed reads `MONGODB_URI` from `.env` (or the environment), prints the database it is wiping, and refuses to run when no URI is set.

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

An AI voice agent phones patients for two jobs, and a third agent answers the hospital's line:

- **Confirmation:** "Will you be able to come on Sunday, 27 September at 10 AM?" The patient confirms, picks one of two alternative slots, or cancels. The appointment is updated to match.
- **Booking:** offers two free slots (on different days when possible) for a stated reason. If the patient picks one, the appointment is created and marked confirmed, and a linked follow-up is updated.
- **Inbound:** a patient phones the hospital. The agent verifies them, then tells them their appointments and can confirm, move, cancel or book one while on the call (see below).

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
  1. Create the agents from the scripts (AI Call Agent → Agent Scripts shows them with the exact variables, outcome labels, data fields and inbound tools).
  2. Set `CALL_PROVIDER=snapserve`, the `SNAPSERVE_*` ids, `SNAPSERVE_API_KEY`, `CALL_WEBHOOK_SECRET` and (for inbound) `CALL_TOOLS_SECRET`, then restart.
  3. Make the API reachable over https. For a test, `cloudflared tunnel --url http://localhost:4000` prints a temporary `https://….trycloudflare.com` address. Enter it under AI Call Agent → Automation → Public address, and the Agent Scripts tab shows every URL to paste.
  4. Give each agent the post-call notify URL `https://<api-host>/api/calls/webhook/snapserve`. If SnapServe lets you add headers to it, send `CALL_WEBHOOK_SECRET` in an `X-MediOS-Webhook-Token` header. If it only takes a URL, add `?token=<CALL_WEBHOOK_SECRET>` instead. Error logs replace the token in a URL with `[redacted]`, but proxies and tunnels may still log it, so prefer the header.
  5. Press **Check connection** on the AI Call Agent screen. It reads each agent (found, active) and the wallet balance with your key, and places no call.
  6. Make one test call to your own number. A result whose outcome cannot be read is kept on the call (`rawResult`, shown as "What the provider sent") so the mapping can be fixed.

  Results follow SnapServe's documented shapes. Post-call notify sends the call object; event subscriptions wrap it in `data`. The outcome and the data fields arrive in `dispositionResult`, keyed by field name. Field names are matched without case or punctuation.

  The API never retries a failed start request on its own, because the call may have gone out anyway.

**Inbound calls** (`src/modules/calls/inbound.service.ts`). The inbound agent has mid-call tools, set up in SnapServe under the agent's Tools → Custom tools. Each is a POST to `/api/calls/tools/<name>` with `CALL_TOOLS_SECRET` in `X-Webhook-Secret`:

| Tool | Does |
|---|---|
| `find_patient` | Verifies the caller and returns a `caller_ref` plus their next three appointments (first name, day, time, doctor, type) |
| `list_appointments` | Lists them again |
| `find_free_slots` | Three free slots from a preferred day; with `appointment_id` (to move an appointment), that appointment's own doctor's slots |
| `book_appointment`, `reschedule_appointment`, `cancel_appointment`, `confirm_appointment` | Change the verified patient's appointments |
| `request_callback` | Front-desk task; `urgent` makes it a high-priority alert |

- **Verification.** The agent always collects the registered mobile number, the patient's full name (spelt in English letters) and the date of birth. The full name must match: every word on record longer than one letter, honorifics ignored, at most two extra words. Then:
  - **Calling from the registered number** (caller ID): the date of birth must match too, when one is on file.
  - **From another number, or with no caller ID:** a date of birth must be on file and must match. Without one, the caller cannot be verified on the line, and the agent offers a call back to the number on record.
  - A family sharing one number is told apart by full name, then by date of birth. A wrong date of birth for a patient who has one on file counts as a failure, even when a relative with no date of birth shares the name, so a guess is never verified as that relative.
  - Every mismatch gets the same answer, which never says which detail was wrong or how many tries are left. A missing date of birth always gets the same "ask for the date of birth" answer, whether or not the name matched.
  - **Where the caller ID comes from.** The caller's number and the call id are read only from SnapServe's headers (`X-SnapServe-From`, `X-SnapServe-Call-Id`; the names are assumed until the go-live check below) or from the request envelope around wrapped arguments (`args`, `arguments`, `parameters` or `input`). They are never read from the arguments themselves, which the language model fills in. Without them, every caller needs a date of birth on file.
  - Three failures within 30 minutes of each other lock checks for that number and create a task to call back. A success does not clear the count. Locks within 24 hours grow: 30 minutes, then 2 hours, then 24 hours. From the second, an admin alert names only the number's last four digits.
- **Sessions.** A match opens a 20-minute session (`inboundsessions`). Every later tool must quote its `caller_ref`, and the session is bound to the call that opened it (the call id, or the caller's number when there is none), so changes only ever touch the verified patient on that call. It ends when the call is logged. Appointments and slots are referred to by short codes (`A1`, `S2`), never by database ids.
- **What callers hear.** First names, dates, times, the doctor and the visit type; never UHIDs or clinical details. Answers are plain JSON with a `message` telling the agent what to do next.
- **Changes by phone** can be switched off by an admin (Automation → Calls to the hospital). The agent then takes a message for the front desk instead. Callers cannot change an appointment whose time has passed, or book more than 90 days ahead.
- **The call log.** When an inbound call's result arrives (`direction: inbound`, or from `SNAPSERVE_INBOUND_AGENT_ID`), it is logged as an `inbound` call, once per provider call id. The changes come from the caller's session, found by the call id or, failing that, by the caller's number during the call. When more than one session could fit, none is attached. An unverified caller is logged without a patient. The agent's "Needs staff", "Wrong number" and "Not verified" outrank what the call changed. "Needs staff" creates an urgent alert unless the agent already raised an urgent callback.
- **Go-live checks for the first live inbound call:**
  - **Where the caller's number arrives.** Confirm where SnapServe puts it on tool requests: a header or the envelope. If it is somewhere else, update `toolContext` in `calls.controller.ts`, never by reading the arguments. The call log's "What happened" says "Verified by caller ID…" only when the number arrived.
  - **The call id.** Confirm that SnapServe's tool requests carry the call id. With it, a result always finds its session, however late it arrives. Without it, a result that arrives more than about 2 minutes after the call ends is logged as "Unverified caller", even though the changes were made.
- `none` (production default): call endpoints answer 503.

Before using real calls, get patients' consent to automated calls and follow TRAI calling-hours and DND rules. Transcripts are health data: restrict who can read them.

---

## 🛏️ Beds and admissions

The `beds` module is the live bed board and the admit flow (admit, transfer, discharge, clean, block). A bed is `free`, `held`, `occupied`, `cleaning` or `blocked`, and one bed holds one patient: holding and occupying are single conditional updates, so two people racing for a bed get one success and one clear conflict error.

- **Rules decide, AI advises.** Fixed rules (free and cleaned, ward gender, room class, needed features such as oxygen or a monitor) remove beds that must not be used. The rest are ranked by preferences (room class match, nearness to the nurses' station and the department, step-up care). The AI sees only the top 5 and may reorder them and explain up to 3 in plain English (each reason at most 140 characters). If the AI is off, slow or answers badly, staff see the rule-based list and no error.
- **Bed hold.** A chosen bed is held for 5 minutes while the admission is confirmed; `DELETE /api/beds/:bedId/hold` gives it back.
- **Roles.** Board, stream, overview, request lists and discharge: admin, doctor, nurse, staff. Bed requests (create, cancel, confirm or dismiss a notes need), suggestions, hold, admit by hand and transfer: admin, doctor. Mark cleaned, block and unblock: admin, nurse, staff. Ignoring the rules (with a reason): admin and doctor. The "Allocate beds automatically" switch: admin. Pharmacist and lab have no access.
- **Routes** (all under `/api/beds`): `GET board`, `GET stream` (server-sent events: `changed` when a bed changes, `request` when a Bed Agent request changes state, and `ping`), `POST suggestions`, `POST suggestions/:id/refine`, `GET :bedId/admission` (the admitted patient and their needs, for a transfer), `POST :bedId/hold`, `DELETE :bedId/hold`, `POST :bedId/admit`, `POST :bedId/transfer`, `POST :bedId/discharge` (body `{ admissionId }`, null for a sample occupant), `POST :bedId/clean`, `POST :bedId/block`, `POST :bedId/unblock`.
- **Privacy.** The AI never gets the patient's name, UHID, phone, address, email or any database id. Doctor's notes (at most 4,000 characters) are stripped of those details first, and beds go out as per-request tokens. Every suggestion, its AI output or failure, and the bed finally chosen is saved for later review.
- **The Bed Agent.** A doctor or admin files a bed request (`POST /api/beds/requests`). The agent works through open requests by priority, asks the same rules and AI as above, and assigns the best free bed. It tries up to 5 beds per pass, retries waiting requests every 60 seconds, and after 3 unexpected errors hands the request to staff with an alert in Tasks & Alerts. When the doctor's notes hint at a need that wasn't ticked, oxygen and high fall risk are added automatically (they never change the ward), while isolation, a ventilator, pregnancy and a monitor are held for a doctor to confirm or dismiss. Every minute it also closes requests that no longer make sense, including ones that need attention: the patient to transfer has left the bed, or the patient to admit was admitted by hand.
- **Request routes** (under `/api/beds`): `POST requests`, `GET requests`, `GET requests/:id`, `POST requests/:id/cancel`, `POST requests/:id/notes-need`, `GET overview` (cards with trends, discharge plan, movements) and `GET snapshots` (hourly counts).
- **Settings switch.** Admins can turn the agent's automatic assigning off with "Allocate beds automatically" (`ai.bedAutoAllocate`, on by default). Requests then wait for staff to assign a bed by hand.
- **Data.** `npm run seed` loads a demo layout of 11 wards and 138 beds. About 98 occupied beds hold made-up sample inpatients (admission records marked `sample`, with no Patient behind them), 168 hourly bed snapshots for the past 7 days, and 10 past requests, so the overview, discharge plan and trends are not empty. For the hospital's real layout, see the CSV import below.

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
- It refuses to run while any bed is occupied or held (`Beds are in use (N occupied or held)...`), and also while any admission, bed suggestion or Bed Agent request exists (`Admission history exists. Importing replaces all beds and would delete 4 admissions, 2 bed suggestions, 10 bed requests and 168 hourly snapshots...`); it changes nothing in either case. `--force` replaces the wards and beds anyway.
- Every import that goes ahead also deletes all admissions, bed suggestions, Bed Agent requests and hourly bed snapshots, because they point at or describe the old beds, and marks the requests' open alerts in Tasks & Alerts as Completed. Hourly snapshots alone never stop an import: the API takes one at every start.
- It prints the database host (never the full address). Unlike `npm run seed`, it does not read `.env`: set `MONGODB_URI` on the command line.

---

## 🧭 Coordinator

The Coordinator is the one place that follows a patient's journey across the hospital's agents. Each agent reports to it (today the Bed Agent), and it keeps:

- **Cases:** one per patient (`CASE-0001`, ...), open until every agent's close check passes.
- **A message log:** what each agent told the others, with the UHID and bed label, never the patient's name.
- **Clocks, escalations and approvals:** a clock that runs out raises an escalation up a ladder of duty titles. Things that need a person become approvals.
- **Hourly snapshots** for the overview cards and trends.

- **Routes** (all under `/api/coordinator`): `GET overview`, `GET snapshots`, `GET cases`, `GET cases/:id`, `GET messages`, `GET agents`, `GET approvals`, `POST approvals/:id/act`, `POST approvals/:id/reassign`, `POST escalations/:id/ack`, `GET rules`, `PUT rules/:key`, `GET request-types`, `GET ladders`, `PUT ladders`, `GET titles`, `PUT titles`, `GET staff`, `POST ask` and `GET stream`.
- **The stream.** `GET stream` is server-sent events. The web app listens to it so the Coordinator page updates live.
- **Settings.** Settings → Coordinator (admins) switches each agent's rules on and off. Duty titles (for example Duty administrator, Medical superintendent) and ladders (who an escalation goes to, step by step, and how long to wait) are set with `PUT titles` and `PUT ladders`. A title nobody holds goes to every admin.
- **The Ask box.** `POST ask` answers questions about the hospital's activity. The AI never sees names, UHIDs or database ids: they are replaced before anything is sent.
- **Demo data.** `npm run seed` also loads about a dozen cases with their messages, one open approval, one expired bed-wait clock with an open escalation (it moves up its ladder about 10 minutes after seeding) and 168 hourly snapshots.

---

## 🚑 Emergency Room

The ER agent runs the emergency department's front door: arrival, triage, doctor review, bays and the fast-track pathways. Fixed rules decide the triage colour, the targets and the pathways; the AI only explains and drafts. It lives in `src/modules/er`.

- **Visits:** one per arrival (`ER-0001`, ...), with a status of waiting for triage, waiting for a doctor, in treatment, waiting for a bed or left. A patient has at most one open visit. An unknown patient is registered as a placeholder (`Unknown male, ER-0012`, details pending) that staff fill in later.
- **Triage:** red, orange, yellow or green. The doctor target is 10, 30, 120 or 240 minutes from arrival, and triage itself must happen within 10 minutes.
- **Pathways:** chest pain, stroke and sepsis start from the complaint and vitals (switch `er-auto-pathways`), each with timed steps.
- **Bays:** 12 bays (two for resus) and 8 stretchers; a bay holds one visit.
- **With the Coordinator:** each visit has a case, and the ER sends messages (never a name) such as `er.arrived`, `er.triaged` and `er.left`. Its clocks (`er-triage`, `er-doctor` and one per pathway step) escalate up the `er` ladder: ER nurse in charge, ER consultant, Medical superintendent. A patient admitted from the ER waits as a Bed Agent request on the same case.
- **Routes** (all under `/api/er`): see `er.controller.ts`.
- **Demo data.** `npm run seed` also loads about 25 visits on the clinic day (15 in the ER across all four colours and every status, the rest gone home or elsewhere), their cases, clocks and messages, one overdue doctor review with an open escalation (about 5 minutes late, then it moves up its ladder), one patient waiting for a bed, one placeholder patient, one expected arrival and 168 hourly snapshots. Where the main demo has too few General Medicine patients, the seed adds made-up ones (marked "ER demo patient" in the address). The ER seed runs only inside the full `npm run seed`, and it clears all ER data first: every ER visit, expected card and bay (including an admin's bay edits), every ER snapshot, the ER's messages, cases and escalations, its made-up patients and every "Unknown …" placeholder patient. Reseed right before a demo: clocks run on real time, so seeded patients go overdue within minutes.

---

## 🧪 Lab Agent

The Lab agent runs the lab's day: orders, sample collection, receiving and rejecting samples, result entry, validation by a second person, release and critical values. Fixed rules flag every value; people enter, validate and act; the AI only summarises released results (with a template fallback). It lives in `src/modules/lab`.

- **Requests:** a doctor orders up to 10 tests at one priority (`LR-0001`, ...), and each tube becomes a sample (`S-260926-0001`, ...). Priorities are STAT, urgent and routine (collect within 15, 60 or 240 minutes).
- **Repeats:** with `repeatAfterHours` a second request is made for later. It has the same collection window, counted from its scheduled time, and its turnaround counts from that time too. The collection list gives its `scheduledFor` and `notBefore` (15 minutes before); collecting it earlier than that is refused (409 "This repeat is due at HH:MM.").
- **Structured text results:** a text result is picked from a list, never typed. Blood culture is `No growth` or `Growth`; urine protein and sugar are `Nil`, `Trace` or `1+` to `4+` (`Negative` and `Absent` are stored as `Nil`). The first option is normal, the others abnormal, and culture `Growth` is critical. Any other value is refused (400, naming the parameter and its options). `GET /api/lab/catalogue` lists the options. A text result can carry a comment of up to 200 characters, such as the organism grown. The comment appears on the Lab Report next to the value. It is never flagged, never sent to the AI and never put in a message.
- **Two-person rule:** the person who enters a result cannot validate it. Release writes the Lab Report, and an amendment needs a reason and a second validation. The validator's worklist shows an amendment's reason and the released values it replaces. An amended report keeps its first date and time and gains `amendedAt`.
- **Critical values, one acknowledgement path:** a critical result raises a "Lab Alert" in Tasks & Alerts, linked `lab-line:<id>`, and starts the `lab-critical` clock. Only acknowledging the result on the Lab page (doctor or admin) clears it. Tasks & Alerts refuses to tick it off (409), whatever the role.
  - Unacknowledged after 15 minutes, it escalates up the `lab-critical` ladder (Duty doctor, then Medical superintendent).
  - The escalation takes over the same alert. Its text names the request and test, for example "Critical result acknowledgement overdue — LR-0019 · Troponin I", and never the patient.
  - The escalation can't be acknowledged by itself (409). It closes, and its alert completes, when the result is acknowledged.
  - The Critical list keeps an unacknowledged critical even while an amendment of it awaits validation, with the patient, the location and every critical value.
- **With the Coordinator:** each request joins the patient's case, and the Lab sends messages (never a name, never free text) such as `lab.ordered`, `lab.received` and `lab.resulted`.
  - Its clocks are `lab-collect`, `lab-recollect`, `lab-tat` and `lab-critical`. Each carries a short detail (the request number and tests), which its escalation shows. The first three escalate up the `lab` ladder: Lab in charge, Duty administrator, Medical superintendent.
  - **Turnaround escalation counts from receipt:** `lab-tat` is due at `escalateAt`, the later of the earliest open test's due (order or scheduled time plus its target) and the first receipt plus that target. So a sample drawn late inside its collection window isn't escalated the moment it arrives. The on-time figures still compare release with order plus target (`tatDueAt`).
  - **Reconcile:** a scheduler pass every 60 seconds resends anything a crash left unsent. `reconcile()` covers orders, collection, request-done and reports. `reconcileCriticals()` resends `lab.critical` for an unacknowledged critical with no clock, and `lab.critical-acked` for an acknowledged one whose clock still runs. One bad row never stops the pass.
  - Lab targets and critical limits change only through `PUT /api/lab/targets` and `PUT /api/lab/limits` (admin). A `lab` section in a general settings save is ignored.
- **Routes** (all under `/api/lab`): see `lab.controller.ts`.
- **Demo data.** `npm run seed` also loads about 30 requests on the clinic day: in the ER (on the open ER cases, one with a blood culture for the sepsis pathway), on the wards (on the admitted patients' cases) and in outpatients (cases the Lab opens for patients who had none). They cover every state: waiting, collected, received, awaiting validation, released (one amended) and cancelled, with two rejected samples that each have a recollection. Three results are critical: one released five minutes ago and still unacknowledged (its clock runs out about 10 minutes after the seed, then it escalates), and two acknowledged by Dr. Shajin. Every released result has its Lab Report, and 168 hourly snapshots feed the cards. Demo logins: `lab@medios.ai` enters results (and holds Lab in charge), `pathologist@medios.ai` ("Dr. Meera Nair") validates them, and `doctor@medios.ai` holds Duty doctor; password `Admin@123`, local only. The Lab seed runs only inside the full `npm run seed`, and it clears only Lab data first: its requests, samples, lines, locations and snapshots, the Lab's messages, clocks, cases and escalations, its Lab Alerts and the Lab Reports that came from a test line. The main demo's own lab reports stay. Reseed right before a demo: clocks run on real time, so seeded work goes overdue within minutes.

---

## 💊 Pharmacy Agent

The Pharmacy agent runs the medicine side of the hospital: doctors order medicines (and OPD prescriptions flow in on their own), fixed rules flag every line, a pharmacist approves, queries the doctor or rejects, and approved lines are issued from stock, oldest expiry first. Rules flag and people decide: the agent and the AI never change a dose, swap a drug or approve. It lives in `src/modules/pharmacy`.

- **Checks:** allergy, clashes, doubles, dose, kidney function (eGFR from the latest Kidney function report) and age, over every active line of the patient. An unconfirmed red allergy flag can only be confirmed by a doctor; a released kidney result re-checks the doses that depend on it and can open a kidney query.
- **Queries:** a pharmacist (or the agent, for an allergy or a new red kidney flag) asks the doctor; the doctor answers once on the Pharmacy page (Keep, Change, Cancel, Stop). A query alert in Tasks & Alerts (`pharmacy-line:<id>`) can only be closed by answering.
- **Stores and stock:** the Main pharmacy holds every product; the ER holds the emergency set. Reorder levels raise one low-stock alert per product and store, and a restock clears it. Batches near expiry (90 days by default) and expired ones are listed.
- **With the Coordinator:** each order joins the patient's case and the agent sends `pharmacy.*` messages (never a name or free text). Its clocks are `pharmacy-check`, `pharmacy-issue` (ER and wards only; OPD patients collect at the counter) and `pharmacy-query`, escalating up the `pharmacy` and `pharmacy-query` ladders.
- **Roles:** admin and doctor order and answer queries; admin and pharmacist check, issue and manage stock; nurses read; lab and front desk have no access.
- **Routes** (all under `/api/pharmacy`): see `pharmacy.controller.ts`.
- **Demo data.** `npm run seed` also loads the pharmacy day (`src/database/seed-pharmacy.ts`, run after the Lab seed): stock (Main holds all 75 products, the ER the emergency set, three products low, ER ticagrelor at 0, two batches near expiry and one expired, each low pair with its alert) and 25 medicine orders in every state across the ER, the wards and the outpatient counter. The ER chest-pain man (Mohan Raj, 62, 64 kg) has aspirin, clopidogrel and isosorbide dinitrate issued, atorvastatin approved with a running issue clock, and enoxaparin waiting to be checked with "Kidney function not known". His Kidney function test is received in Lab and waits for a result: enter creatinine 2.5 and release it, and a kidney query opens on enoxaparin (eGFR 28). An admitted patient with a Patient record gets a Penicillin allergy and an amoxicillin-clavulanate line held in an allergy query. Five prescription orders (the demo prescription and four new ones, marked `Pharmacy demo`) wait at the counter. `pharmacy@medios.ai` ("Neethu George") holds Pharmacist on duty; password `Admin@123`, local only. The Pharmacy seed clears only Pharmacy data first (its orders, lines, locations, stock, snapshots, messages, clocks, escalations, alerts, cases and the `Pharmacy demo` prescriptions). Reseed right before a demo: clocks run on real time, so seeded work goes overdue within minutes.

---

## 🗓️ Scheduling Agent

The Scheduling agent runs the hospital's timetable: doctor outpatient sessions, the duty roster, procedure rooms and their teams, specialist consults, the waitlist for anything that has to move, and follow-ups. Fixed rules book and decide; people confirm anything a patient must agree to; the AI only summarises counts. It lives in `src/modules/scheduling`.

- **Doctors and appointments:** each doctor has their own sessions, slot length and leave, and every appointment names a doctor and holds a slot key, so two bookings cannot take the same slot (a clash is a 409). Booking, moving and cancelling go through one service; the AI call agent offers the same free slots (it keeps its 120-minute same-day lead, the front desk needs 15 minutes).
- **Leave:** adding leave over booked appointments moves each of them to the waitlist with the next two free slots of the same doctor offered. Nothing is moved by itself: a person speaks to the patient, then presses **Book offered slot** (or **Find another slot**, **Call patient** when calls are on, **Cancel booking**).
- **Roster and duty titles:** staff are rostered per day in a shift (morning 08:00-14:00, evening 14:00-20:00, night 20:00-08:00, on call) and can hold duty titles for that shift. The Coordinator's escalation ladders ask the roster first and fall back to the fixed holders when nobody on the roster holds the title. So a pharmacy escalation names the pharmacist rostered now; delete the roster entry and it names the fixed holder again.
- **Procedures and rooms:** a doctor requests a procedure (STAT, urgent within 24 h, routine within 14 days). The planner books the earliest 15-minute start where the room (Cath lab, OT 1, OT 2, Procedure room, X-ray, CT, Ultrasound) is open, unblocked and free (turnover included) and every role of the team is on shift and free, picking the least-loaded person. It tells the case, Lab and Pharmacy (`scheduling.procedure-booked`). A request that fits nowhere waits as **Can't book yet** and is retried every minute and whenever the roster, rooms or bookings change. People with no login are reached by an alert to the fallback title (OT and cath lab in charge, or Duty administrator for imaging).
- **Activate cath lab (emergencies):** a STAT angiography that starts now (rounded up to the minute, any hour). Planned cases in its way that have not started are **bumped** to the waitlist (reason Bumped) and their team is told; roles are filled in the order free on shift, free on call, a doctor in their own clinic (their outpatients wait), a member of a planned case (that case is bumped). A role nobody can fill books anyway as unfilled and raises a High alert to the fallback title. The coordination rule **Emergencies may bump planned procedures** (admin, on by default) turns bumping off.
- **Consults:** a doctor requests a department consult (STAT 30, urgent 120, routine 1440 minutes by default). The agent pages the department's on-call doctor (else the Duty doctor holders) with a High alert and starts a clock on the `consult` ladder (Medical superintendent). The paged doctor, a doctor of the department or an admin **Accepts** and marks **Seen**; Seen stops the clock, completes the alert and closes any escalation. A patient who leaves the ER or is discharged cancels the open consults.
- **Follow-ups:** `POST /api/scheduling/followups` books "OPD with this doctor or department in N days" at the first free slot from that day (within 7 days) and records the follow-up; with no slot it goes to the waitlist.
- **Conflicts:** a pass every 60 seconds checks doctor overlaps, a blocked room over bookings, leave over bookings, a doctor running late, a procedure not started, and a duty title with no holder. Each raises one System alert and clears itself when the cause goes.
- **With Pharmacy and Lab:** a contrast procedure puts an amber "hold metformin" flag (and one alert) on the patient's metformin lines; angioplasty with no dual antiplatelet medicines raises a Critical alert. The booking dialog can also place the procedure's pre-tests as a normal Lab order.
- **With the Coordinator:** Scheduling registers as an agent; each booking joins the patient's case. Messages are `scheduling.procedure-requested|booked|bumped|started|done|cancelled|cant-book`, `scheduling.consult-requested|paged|accepted|seen|cancelled` and `scheduling.followup-booked`, never carrying a name or free text. Its close check keeps a case open while a consult is paged or accepted or a procedure is booked or in progress. A reconcile pass resends anything a crash left unsent.
- **Roles:** admin, doctor, nurse and front desk read; admin, doctor and front desk book, move and cancel appointments and run every waitlist action; admin and doctor request procedures and consults, Activate cath lab and order follow-ups; admin, doctor and nurse start and finish procedures; admin only edits the roster, staff, rooms, blocks, doctor slot length and Settings → Scheduling. Pharmacist and lab have no access.
- **Routes (in brief, all under `/api/scheduling`):** `overview`, `snapshots`, `summary`, `catalogue`; `doctors`, `doctors/:id/slots`, `doctors/:id/profile`; `appointments` (book, `:id/move`, `:id/cancel`, `:id/wants-earlier`); `procedures` (list, `board`, request, `activate-cath-lab`, `:id/start|done|cancel`); `consults` (`:id/accept|seen|repage|cancel`); `roster` (`entries`, `copy-week`), `staff`, `duty-now`; `rooms` (`:key/blocks`); `waitlist` (`:id/book|find|cancel`); `followups`; `settings`. The exact roles are in `scheduling.controller.ts`.
- **Demo data.** `npm run seed` also loads the scheduling day: 11 doctors with their own timetables, a week of roster, about 32 appointments on the clinic day, 12 procedures (one in progress, one done, one that cannot book), three consults (one overdue and already escalated), waitlist items and a doctor on leave. The ER chest-pain man (Mohan Raj) has an accepted STAT cardiology consult (CO-0001) and a coronary angiography booked at 08:30 on 28 Sep (PR-0012), which puts the contrast flag on his metformin. `rajesh@medios.ai` is the cardiologist and `kavitha@medios.ai` another; `nurse@medios.ai` holds ER nurse in charge and OT and cath lab in charge, `pharmacy@medios.ai` holds Pharmacist on duty and Chief pharmacist. Password `Admin@123`, local only. The Scheduling seed clears only Scheduling data first. Reseed right before a demo: clocks run on real time and the roster follows the time of day (the morning shift starts at 08:00 clinic time).
- **Test copy for this branch:** API on 4800, web on 5188, database `medios_scheduling_dev`.

---

## 💰 Revenue Agent

The Revenue agent keeps each patient's running bill and money trail: charges collect themselves from the other agents, it drafts an estimate, asks for an advance deposit and top-ups, takes payments with numbered receipts, builds the final bill and pays refunds. It never holds care for money: no order, test, medicine, bed or procedure is ever blocked or reordered because of a bill. Self-pay only for now (every record has `payer: 'self'`). It lives in `src/modules/revenue`.

- **Bills:** one per visit, numbered BL-0001 (receipts RC-0001, refunds RF-0001). An OPD bill belongs to the appointment, an ER bill to the ER visit and an admission bill to the Coordinator case. An ER bill continues as the admission bill when the Bed Agent assigns a bed. Totals (charges, discounts, payments, refunds, balance) are whole rupees changed only by one atomic adjust.
- **Charges collect themselves:** ER fees, collected lab tests, issued medicines, procedure bookings, the OPD consultation fee at check-in (every path) and one bed day plus one nursing day per started 24 hours on the clinic clock. Each source is charged once, even if a message arrives twice (the source key is unique). Something with no price goes on at 0 marked **Needs price**; it never blocks anything.
- **Estimates and deposits:** an estimate is drafted when a patient is admitted or a procedure is booked and redrafted from current records; the desk can edit the days and add lines. The deposit task (by ward group) appears only once a bed is assigned, never while the patient is in the ER. A top-up task appears when charges reach the threshold (80 percent) of what is paid.
- **Payments and refunds:** cash, UPI or card, with a receipt; an admin can cancel a payment. A refund is requested, approved by an admin, then paid by the desk (it pays the smaller of the approved amount and what the bill owes).
- **Final bill:** Prepare builds it (with warnings for anything still open), Settle needs a zero balance and sends `revenue.bill-settled`, which passes the Coordinator close check **Bill settled**. A write-off or refund that leaves the balance at 0 settles it too.
- **Corrections with a trace:** change, reversal, discount and write-off are never deletes. A desk request waits for an admin (an Approval); an admin's own request applies at once. Nothing is silently changed.
- **With the Coordinator:** Revenue registers as an agent. Messages are `revenue.estimate-ready|deposit-due|topup-due|topup-met|payment|final-requested|bill-final|bill-settled|refund-due|refund-paid|refund-void` (never a name or free text). Clocks: `revenue-final` (60 minutes), `revenue-topup` (240) and `revenue-refund` (2880), on the `revenue` ladder up to Billing in charge. Two rules: **Never hold care for money** (locked on) and **Remind the billing desk to collect deposits**.
- **Reconcile and scheduler:** a pass every minute adds bed days, redrafts estimates, re-sends missed messages and tasks, catches up missed charges, and settles reception kiosk bills whose visits are over (or that are from an earlier clinic day). It never looks before the agent's first start time. An hourly snapshot feeds the trend cards. The AI only writes a day summary and a bill explanation from counts and line names, de-identified.
- **Roles:** admin and front desk (the billing desk) read everything, take payments, add charges, ask for corrections and refunds, prepare and settle. Admin alone edits the price list and settings, approves and cancels payments. Doctor and nurse read only a patient's running total (`GET patients/:id/total`). Pharmacist and lab have no access (403).
- **Routes** (all under `/api/revenue`): `overview`, `snapshots`, `summary`, `explain/:billId`; `bills` (list, `:id`, `:id/charges`, `:id/payments`, `:id/final/request|prepare`, `:id/settle`, `:id/corrections`, `:id/refund`); `approvals`; `estimates` (every estimate of a bill not yet settled), `estimates/:billId`, `PUT estimates/:id`; `payments` (`:id/cancel`, `:id/receipt`); `refunds/:id/pay`; `price-list`; `settings`; `patients/:id/total`. Exact roles are in `revenue.controller.ts`.
- **Settings** (Settings → Revenue, admin): deposits by ward group, the estimate days and daily allowance by ward, the top-up threshold (50 to 100 percent), the three clock targets and the receipt header.
- **Demo data.** `npm run seed` also loads the revenue day (`src/database/seed-revenue.ts`, run last, after the Scheduling seed): the price list and about 27 bills built through the live services, in every state. Mohan Raj's open ER bill carries the estimate for his booked angiography and no deposit task; James Wilson's HDU stay has a top-up due; David Raj's final bill waits with a Needs price line; five ended ER visits give settled bills, an approved refund (RF-0001, 1,900 rupees, to pay) and a discount waiting for approval; the clinic day's outpatient fees and a walk-in complete it. The billing in charge title is held by the admin. The Revenue seed clears only Revenue data first and stamps the agent's start time at the seed. Clocks run on real time, so reseed right before a demo.
- **Checks for this module:** `MONGODB_TEST_URI=mongodb://localhost:27018/medios_revenue_test npm run test:file -- src/modules/revenue/revenue-bills.service.spec.ts` for one spec, `npm test` for everything (run one spec file at a time; they share one database).
- **Test copy for this branch:** API on 4900, web on 5189, database `medios_revenue_dev`.

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

## 🧾 Reception Kiosk

A patient registers or books an OP visit on a tablet kiosk, pays, and gets a token. The modules are `src/modules/reception` (kiosk and staff routes, providers) and `src/modules/opd` (departments, OP doctors, availability).

- **Departments and OP doctors** are managed in the web app under Settings > Departments. They are the same records the Scheduling Agent books appointments with.
- **Availability** at the kiosk comes from the doctor's OP sessions, their queue and Scheduling's leave: a doctor on leave today is listed as "On leave today" and cannot be booked (`DOCTOR_NOT_BOOKABLE`). The kiosk's doctor list and visit booking use the same rule.
- **Doctor-wise tokens.** Each OP doctor has their own line and numbers (`G-024`). A token joins the doctor asked for; without one, the doctor of the appointment being checked in, else the reception default doctor. An appointment is checked in only on its own doctor's line. When that doctor is inactive, checking the appointment in is refused (409 `DOCTOR_INACTIVE`, naming the doctor) unless a doctor is chosen; with an active doctor chosen, the appointment moves to that doctor (and their slot) and is checked in on their line.
- **Kiosk devices** are added in Token Queue > Displays & Settings. Creating one shows a setup QR for the tablet app (it carries the address and the key once).
- **Cash payments** are confirmed by staff on the Token Queue. The token is issued on confirmation.
- **Billing is the Revenue Agent's.** A paid visit gets its OP number and token first, then goes on a Revenue bill once: when its token checked in the patient's appointment with that doctor, the consultation is that appointment's own check-in charge; otherwise the visit's own consultation line goes on the patient's OPD bill for the day, else a walk-in bill. The payment is a `kiosk` payment with an RC- receipt, recorded by the kiosk device; the method and its reference are in its reference text (`Cash at counter · <who took it>`, `UPI · <ref> · SAMPLE`). A Revenue failure never holds back the token: the visit is listed as needing attention and is retried every minute and on each staff list call, the least recently tried first. After 7 days it is no longer retried, and its row says to add the payment by hand on the Revenue page. Visits paid before this hold an old `OPB-` invoice, which stays as history. The visit's bill settles by itself, as an appointment's OPD bill does, once the visit's token is marked done and nothing is due, needs a price or waits for an approval; Revenue's minute pass also settles such a bill from an earlier clinic day (the backstop).
- **Tracking page.** A patient can follow a visit on the public `/track` page of the web app. Links use `PUBLIC_WEB_URL`.
- **Sample providers.** With `PAYMENT_PROVIDER=sample` and `SMS_PROVIDER=sample`, payments are simulated and OTP codes are shown on the kiosk. In production this is allowed but logs a loud warning. Never use it with real patients.
- **Collections:** `opvisits`, `opsequences`, `receptionsessions`, `otpchallenges`, plus the shared `departments` and `opdoctors`.

**End-to-end check.** With a local API running (sample providers), run:

```bash
API=http://localhost:4500/api npm run e2e:reception
```

It exercises every kiosk path. Card with UPI, and Find my record with cash, each check in an appointment the script books with its doctor (the Revenue appointment path); a new patient pays by card (the walk-in path); every paid visit is checked on its Revenue bill (one consultation line, the kiosk payment recorded by the kiosk, nothing due). It also puts the doctor on leave for a moment and checks the kiosk refuses them.

- **What it changes:** it creates an all-day "Dr. E2E Test" doctor, or reactivates the one an earlier run left, and deactivates it at the end; the kiosk and display it adds are removed at the end too. The patients it registers and the appointments it books stay.
- **Local only:** it refuses an API that is not on localhost unless `E2E_ALLOW_REMOTE=true` is set.
- **Reseed** (`npm run seed`) before running it again: the card patient keeps the token from the earlier run.

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
| | `PATCH` | `/api/tasks-alerts/:id/toggle` | Toggle Pending / Completed (409 for escalation alerts and `lab-line:` critical results) |
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
| | `POST` | `/api/calls/provider-check` | Read the provider's agents and wallet with the server's key; no call (admin, doctor) |
| | `POST` | `/api/calls/tools/:tool` | Inbound agent mid-call tools (`X-Webhook-Secret`, no user token) |
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
