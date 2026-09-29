# MediOS AI - Hospital Management Backend API

Enterprise Clinical AI Workstation & Hospital SaaS REST API built with **NestJS**, **MongoDB (Mongoose)**, **JWT Authentication**, and **Swagger OpenAPI documentation**.

---

## 🚀 Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) v11
- **Runtime**: Node.js v24+
- **Database**: MongoDB with [Mongoose](https://mongoosejs.com/) v8
- **Authentication**: JWT (`@nestjs/jwt`, `passport-jwt`, `bcryptjs`)
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
│   │   ├── guards/             # JwtAuthGuard
│   │   ├── filters/            # AllExceptionsFilter
│   │   └── interceptors/       # TransformInterceptor (standard envelope)
│   ├── database/
│   │   └── seed.ts             # Initial clinical dataset seeder (Doctor, Patients, Labs, etc.)
│   └── modules/
│       ├── auth/               # JWT Login, Register, Profile (/api/auth/*)
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
docker compose up -d
```
*MongoDB will be running on `localhost:27017`.*
*(Optional) Mongo Express UI will be available at `http://localhost:8081`.*

### 2. Configure Environment

Copy `.env.example` to `.env` (already created):

```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/medios_hospital
JWT_SECRET=medios_clinical_jwt_secret_key_2026_xyz
JWT_EXPIRATION=7d
CORS_ORIGIN=*
```

### 3. Seed Database with Initial Clinical Data

```bash
npm run seed
```

This seeds:
- Default Doctor: **`doctor@medios.ai`** / Password: **`Admin@123`**
- Primary Patient: **Arun Kumar** (`UHID: MHK202500321`) + Mary Jeni, Selvi P
- Today's appointment queue
- CBC & Lipid lab reports with findings
- Digital Chest X-Ray imaging study
- OPD Billing invoices
- Clinical alerts & messaging threads

### 4. Run Development Server

```bash
npm run start:dev
```

- API Base: `http://localhost:5000/api`
- Interactive Swagger UI: `http://localhost:5000/api/docs`

---

## 🔒 Authentication Flow

1. Send `POST /api/auth/login` with email and password:
   ```json
   {
     "email": "doctor@medios.ai",
     "password": "Admin@123"
   }
   ```
2. Response returns `accessToken`:
   ```json
   {
     "success": true,
     "statusCode": 200,
     "data": {
       "accessToken": "eyJhbGciOi...",
       "user": {
         "id": "...",
         "name": "Dr. Shajin",
         "role": "doctor"
       }
     }
   }
   ```
3. Attach header to subsequent requests:
   ```http
   Authorization: Bearer <accessToken>
   ```

---

## 📋 Comprehensive API Route Catalog

| Module | Method | Endpoint | Description |
|---|---|---|---|
| **Auth** | `POST` | `/api/auth/login` | Doctor/staff login returning JWT |
| | `POST` | `/api/auth/register` | Register new hospital staff |
| | `GET` | `/api/auth/me` | Current authenticated user profile |
| **Dashboard** | `GET` | `/api/dashboard/stats` | Aggregated KPIs, today's schedule, patient flow donut, and alerts |
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
| | `GET` | `/api/medications/adherence/:uhid` | Patient adherence score & refill alerts |
| **Lab Reports** | `GET` | `/api/lab-reports?uhid=...` | Investigation reports |
| | `GET` | `/api/lab-reports/trends/:uhid` | Longitudinal parameter trends (HbA1c, etc.) |
| **Imaging** | `GET` | `/api/imaging?uhid=...` | Radiological studies (X-Ray, CT, MRI, USG) |
| | `PATCH` | `/api/imaging/:id/report` | Radiologist report submission |
| **Billing** | `GET` | `/api/billing/invoices` | List invoices by patient or status |
| | `POST` | `/api/billing/invoices` | Generate new invoice |
| | `PATCH` | `/api/billing/invoices/:id/pay` | Record invoice payment |
| | `GET` | `/api/billing/stats` | Today's revenue & receivables stats |
| **Follow-ups** | `GET` | `/api/follow-ups` | Recall schedule list |
| | `PATCH` | `/api/follow-ups/:id/status` | Update recall status |
| | `POST` | `/api/follow-ups/:id/send-reminder` | Trigger SMS/WhatsApp recall reminder |
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
