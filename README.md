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

The default port is 4000 because macOS's AirPlay Receiver holds port 5000.

### 3. Seed Database with Initial Clinical Data

```bash
npm run seed
```

This replaces the demo collections with the fixtures in `src/database/seed-data/` — the records the web app was designed around, a clinic day on **26 Sep 2026**:
- Logins (password **`Admin@123`** for both): **`doctor@medios.ai`** (doctor) and **`admin@medios.ai`** (admin, can create accounts). Change these before any real use.
- 12 patients; **Arun Kumar** (`UHID: MHK202500321`) has the full chart: 8 consultations, prescription, medications, 8 lab reports, 6 imaging studies, 7 invoices, vitals history, timeline and documents
- The 26 Sep appointment queue, follow-ups, 28 tasks & alerts, 10 message threads and workstation settings

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

- **Access tokens** are HS256 JWTs with issuer, audience, `jti` and a token version. Other algorithms are rejected. Each request re-checks that the user is still active and that the version matches, so a password change or "sign out everywhere" revokes every outstanding token at once.
- **Refresh tokens** are random 384-bit values stored only as SHA-256 hashes, one row per device (`refreshtokens`, expired rows removed by a TTL index). Each refresh token is single-use. Presenting a used one again signals theft and revokes that device's whole token family.
- **CSRF.** Cookie-authenticated endpoints (`refresh`, `logout`) require the `X-MediOS-Client` header, which cross-site forms cannot send and CORS blocks cross-origin scripts from adding.
- **Passwords** are bcrypt (cost 12) and must be 8–72 characters with upper and lower case, a number and a symbol. Unknown emails take as long as wrong passwords and get the same message.
- **Brute force.** 5 wrong passwords lock the account for 15 minutes (`429`). Rate limits: sign-in 10/min, refresh 30/min, password change 5/min, everything else 300/min per IP.
- **Roles** (`doctor`, `nurse`, `pharmacist`, `staff`, `admin`). Only admins create accounts. Only doctors sign documents, report imaging, write prescriptions and SOAP notes. Only admins delete patients. Admins and doctors delete appointments and change settings.
- **Also:** helmet headers, a strict CORS allow-list, 1 MB body limit, Swagger off in production, internal error messages hidden in production, and search input escaped before it reaches a regex.

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
| **Settings** | `GET` | `/api/settings` | Hospital profile, staff, and AI settings |
| | `PUT` | `/api/settings` | Update settings and preferences |
