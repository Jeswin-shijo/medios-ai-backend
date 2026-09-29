import mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/medios_hospital';

async function seed() {
  console.log('🌱 Connecting to MongoDB at', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  console.log('🔄 Seeding database with MediOS AI initial clinical data...');

  // 1. Seed Doctor User
  const usersCol = db.collection('users');
  await usersCol.deleteMany({});
  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash('Admin@123', salt);

  await usersCol.insertOne({
    email: 'doctor@medios.ai',
    passwordHash,
    name: 'Dr. Shajin',
    specialty: 'General Physician & Diabetologist',
    department: 'OPD / General Medicine',
    doctorId: 'MHK-DOC-042',
    avatar: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=400&q=80',
    phone: '+91 98765 43210',
    role: 'doctor',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('✅ Doctor user seeded: doctor@medios.ai (Password: Admin@123)');

  // 2. Seed Patients
  const patientsCol = db.collection('patients');
  await patientsCol.deleteMany({});

  const patients = [
    {
      uhid: 'MHK202500321',
      name: 'Arun Kumar',
      age: 45,
      gender: 'Male',
      phone: '+91 98401 23456',
      bloodGroup: 'B+',
      visitType: 'OPD',
      status: 'Today',
      department: 'General Medicine',
      lastVisit: 'Today, 09:30 AM',
      nextAppointment: 'Tomorrow 10:00 AM',
      doctor: 'Dr. Shajin',
      conditions: ['Type 2 Diabetes', 'Hypertension'],
      allergies: ['Penicillin'],
      insurance: {
        provider: 'Star Health Insurance',
        policyNumber: 'SH-POL-982341-2025',
        validity: '31 Dec 2026',
        coverageType: 'Cashless (₹5,00,000)',
        claimStatus: 'Approved',
      },
      vitals: {
        recordedAt: 'Today, 09:15 AM',
        bpSystolic: 138,
        bpDiastolic: 88,
        heartRate: 78,
        temperature: 98.4,
        spo2: 98,
        weightKg: 74,
        heightCm: 172,
        bmi: 25.0,
        bmiStatus: 'Overweight',
      },
      aiSummary: {
        summary: '45-year-old male presenting with sub-optimally controlled T2D and Grade 1 HTN. Compliance with Metformin has been irregular.',
        keyPoints: [
          'Occasional morning headache and postprandial fatigue reported',
          'HbA1c last recorded 7.1% (mild elevation)',
          'No microvascular complications identified on fundus exam',
          'Needs medication adherence counseling and Telmisartan initiation',
        ],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      uhid: 'MHK202500322',
      name: 'Mary Jeni',
      age: 28,
      gender: 'Female',
      phone: '+91 94440 12890',
      bloodGroup: 'O+',
      visitType: 'OPD',
      status: 'Today',
      department: 'Cardiology',
      lastVisit: 'Today, 09:00 AM',
      nextAppointment: '02 Oct 2026',
      doctor: 'Dr. Shajin',
      conditions: ['Hypertension'],
      allergies: ['Sulfa drugs'],
      insurance: {
        provider: 'HDFC ERGO',
        policyNumber: 'HE-MED-771249-2026',
        validity: '15 Aug 2027',
        coverageType: 'Cashless (₹3,00,000)',
        claimStatus: 'In Progress',
      },
      vitals: {
        recordedAt: 'Today, 08:45 AM',
        bpSystolic: 142,
        bpDiastolic: 92,
        heartRate: 84,
        temperature: 98.6,
        spo2: 99,
        weightKg: 58,
        heightCm: 160,
        bmi: 22.7,
        bmiStatus: 'Normal',
      },
      aiSummary: {
        summary: 'Young female with essential hypertension. Elevated WBC count noted on recent CBC.',
        keyPoints: ['High WBC count 14,500/mcL requires follow-up', 'Amlodipine 5mg well-tolerated'],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      uhid: 'MHK202500323',
      name: 'Selvi P',
      age: 32,
      gender: 'Female',
      phone: '+91 98842 99123',
      bloodGroup: 'A+',
      visitType: 'OPD',
      status: 'Today',
      department: 'Endocrinology',
      lastVisit: 'Today, 10:00 AM',
      nextAppointment: '15 Oct 2026',
      doctor: 'Dr. Shajin',
      conditions: ['Hypothyroidism'],
      allergies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await patientsCol.insertMany(patients);
  console.log(`✅ ${patients.length} patients seeded`);

  // 3. Seed Appointments
  const appointmentsCol = db.collection('appointments');
  await appointmentsCol.deleteMany({});

  const appointments = [
    {
      uhid: 'MHK202500322',
      patientName: 'Mary Jeni',
      age: 28,
      gender: 'Female',
      phone: '+91 94440 12890',
      time: '09:00 AM',
      date: '2026-09-26',
      type: 'Follow-up',
      condition: 'Hypertension',
      status: 'In Consultation',
      consultationDuration: '15 mins',
      checkedInTime: '08:52 AM',
      notes: 'Blood pressure recheck and CBC review',
      tags: ['Priority', 'Cardio'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      uhid: 'MHK202500321',
      patientName: 'Arun Kumar',
      age: 45,
      gender: 'Male',
      phone: '+91 98401 23456',
      time: '09:30 AM',
      date: '2026-09-26',
      type: 'Follow-up',
      condition: 'Diabetes & Hypertension',
      status: 'Checked In',
      consultationDuration: '20 mins',
      checkedInTime: '09:20 AM',
      notes: 'Monthly review of blood sugar and BP log',
      tags: ['Chronic', 'Diabetic'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      uhid: 'MHK202500323',
      patientName: 'Selvi P',
      age: 32,
      gender: 'Female',
      phone: '+91 98842 99123',
      time: '10:00 AM',
      date: '2026-09-26',
      type: 'Follow-up',
      condition: 'Thyroid',
      status: 'Waiting',
      consultationDuration: '15 mins',
      checkedInTime: '09:48 AM',
      notes: 'TSH review and dose adjustment',
      tags: ['Endocrine'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      uhid: 'MHK202500324',
      patientName: 'Ramesh Kumar',
      age: 52,
      gender: 'Male',
      phone: '+91 97910 88231',
      time: '10:30 AM',
      date: '2026-09-26',
      type: 'New Patient',
      condition: 'Chest Pain',
      status: 'Waiting',
      consultationDuration: '25 mins',
      checkedInTime: '10:10 AM',
      notes: 'Evaluate atypical retrosternal discomfort on exertion',
      tags: ['Urgent', 'ECG Required'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await appointmentsCol.insertMany(appointments);
  console.log(`✅ ${appointments.length} appointments seeded`);

  // 4. Seed Lab Reports
  const labReportsCol = db.collection('labtestreports');
  await labReportsCol.deleteMany({});

  const labReports = [
    {
      uhid: 'MHK202500321',
      testName: 'Complete Blood Count (CBC)',
      category: 'Hematology',
      date: '26 Sep 2026',
      time: '08:30 AM',
      status: 'Completed',
      groups: [
        {
          category: 'Red Blood Cells & Hemoglobin',
          parameters: [
            { name: 'Hemoglobin', result: '14.5', referenceRange: '13.5 - 17.5', unit: 'g/dL', status: 'Normal', relativePosition: 60 },
            { name: 'RBC Count', result: '4.8', referenceRange: '4.5 - 5.9', unit: 'mil/uL', status: 'Normal', relativePosition: 50 },
            { name: 'Hematocrit (PCV)', result: '43.2', referenceRange: '41 - 50', unit: '%', status: 'Normal', relativePosition: 52 },
          ],
        },
        {
          category: 'White Blood Cells & Platelets',
          parameters: [
            { name: 'Total WBC Count', result: '7,800', referenceRange: '4,500 - 11,000', unit: 'cells/mcL', status: 'Normal', relativePosition: 45 },
            { name: 'Platelet Count', result: '240,000', referenceRange: '150,000 - 450,000', unit: 'mcL', status: 'Normal', relativePosition: 55 },
          ],
        },
      ],
      aiSummary: {
        findings: ['CBC profile is completely within normal reference limits.', 'No signs of active acute infection or anemia.'],
        interpretation: 'Hematological status is stable.',
        recommendations: ['Routine annual repeat recommended.'],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      uhid: 'MHK202500321',
      testName: 'Comprehensive Metabolic & Lipid Panel',
      category: 'Biochemistry',
      date: '26 Sep 2026',
      time: '08:45 AM',
      status: 'Abnormal',
      groups: [
        {
          category: 'Glucose Metabolism',
          parameters: [
            { name: 'Fasting Blood Glucose', result: '128', referenceRange: '70 - 100', unit: 'mg/dL', status: 'High', relativePosition: 82 },
            { name: 'HbA1c', result: '6.8', referenceRange: '< 5.7', unit: '%', status: 'High', relativePosition: 78 },
          ],
        },
        {
          category: 'Renal & Lipids',
          parameters: [
            { name: 'Serum Creatinine', result: '1.02', referenceRange: '0.7 - 1.3', unit: 'mg/dL', status: 'Normal', relativePosition: 48 },
            { name: 'Total Cholesterol', result: '210', referenceRange: '< 200', unit: 'mg/dL', status: 'High', relativePosition: 74 },
            { name: 'LDL Cholesterol', result: '132', referenceRange: '< 100', unit: 'mg/dL', status: 'High', relativePosition: 76 },
          ],
        },
      ],
      aiSummary: {
        findings: ['Mildly elevated fasting glucose and HbA1c (6.8%).', 'Mild dyslipidemia with elevated LDL (132 mg/dL).'],
        interpretation: 'Moderate glycemic control with secondary hyperlipidemia.',
        recommendations: ['Maintain Metformin therapy.', 'Initiate low-dose Statin (Atorvastatin 10mg) if cardiovascular risk is elevated.'],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await labReportsCol.insertMany(labReports);
  console.log(`✅ ${labReports.length} lab reports seeded`);

  // 5. Seed Imaging Studies
  const imagingCol = db.collection('imagingstudies');
  await imagingCol.deleteMany({});

  const imaging = [
    {
      uhid: 'MHK202500321',
      title: 'Chest PA Digital Radiograph (X-Ray)',
      date: '26 Sep 2026',
      time: '10:15 AM',
      modality: 'X-Ray',
      bodyPart: 'Chest',
      radiologist: 'Dr. Priya Sundaram',
      status: 'Reported',
      thumbnailUrl: 'https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=800&q=80',
      slices: ['https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=800&q=80'],
      findings: [
        'Bilateral lung parenchyma appears clear without focal consolidation or pneumothorax.',
        'Cardiac silhouette is normal in contour and transverse diameter.',
        'Costophrenic angles are acute and clear.',
      ],
      impression: 'Normal study. No active focal pulmonary infiltration.',
      confidenceScore: 98,
      radiologistReport: {
        findings: 'Bilateral lung fields clear. Cardiac silhouette is normal.',
        impression: 'Normal chest radiograph.',
        reportedBy: 'Dr. Priya Sundaram, MD Radiodiagnosis',
        reportedOn: '26 Sep 2026, 11:45 AM',
        status: 'Final Report',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await imagingCol.insertMany(imaging);
  console.log(`✅ ${imaging.length} imaging studies seeded`);

  // 6. Seed Invoices
  const billingCol = db.collection('billinvoices');
  await billingCol.deleteMany({});

  const bills = [
    {
      billNumber: 'INV-2026-0042',
      uhid: 'MHK202500321',
      patientName: 'Arun Kumar',
      billDate: '26 Sep 2026',
      visitType: 'OPD Regular',
      createdBy: 'Dr. Shajin',
      paymentMode: 'UPI / GPay',
      status: 'Paid',
      items: [
        { service: 'General Physician Consultation', category: 'Consultation', qty: 1, unitPrice: 800, discount: 0, amount: 800 },
        { service: 'Complete Blood Count (CBC)', category: 'Lab', qty: 1, unitPrice: 450, discount: 0, amount: 450 },
        { service: 'Comprehensive Metabolic Panel', category: 'Lab', qty: 1, unitPrice: 950, discount: 0, amount: 950 },
        { service: 'Chest X-Ray Digital PA', category: 'Radiology', qty: 1, unitPrice: 650, discount: 0, amount: 650 },
      ],
      subtotal: 2850,
      discount: 0,
      tax: 0,
      totalAmount: 2850,
      paidAmount: 2850,
      balanceDue: 0,
      notes: 'Paid in full via UPI transaction ref #UP8923019',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await billingCol.insertMany(bills);
  console.log(`✅ ${bills.length} invoices seeded`);

  // 7. Seed Tasks & Alerts
  const tasksCol = db.collection('taskalertitems');
  await tasksCol.deleteMany({});

  const tasks = [
    {
      title: 'High WBC count: 14,500',
      subtitle: 'Mary Jeni | CBC',
      patientName: 'Mary Jeni',
      uhid: 'MHK202500322',
      type: 'Lab Alert',
      priority: 'High',
      dueDateTime: 'Today, 09:30 AM',
      status: 'Pending',
      category: 'Critical',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      title: 'Drug interaction alert: Amlodipine + Ibuprofen',
      subtitle: 'Antony Raj | Pharmacy',
      patientName: 'Antony Raj',
      uhid: 'MHK202500325',
      type: 'Medication Alert',
      priority: 'High',
      dueDateTime: 'Today, 09:15 AM',
      status: 'Pending',
      category: 'Critical',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      title: 'Follow-up due: Diabetes & BP Review',
      subtitle: 'Selvi P | Endocrinology',
      patientName: 'Selvi P',
      uhid: 'MHK202500323',
      type: 'Follow-up',
      priority: 'Medium',
      dueDateTime: 'Today',
      status: 'Scheduled',
      category: 'Follow-up',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await tasksCol.insertMany(tasks);
  console.log(`✅ ${tasks.length} tasks and alerts seeded`);

  // 8. Seed Message Threads
  const messagesCol = db.collection('messagethreads');
  await messagesCol.deleteMany({});

  const threads = [
    {
      contactName: 'Hospital Pharmacy',
      category: 'Pharmacy',
      preview: 'Alternative for Telma 40mg is available as Telpres 40mg. Request confirmation.',
      time: '09:42 AM',
      unreadCount: 1,
      online: true,
      messages: [
        {
          sender: 'staff',
          text: 'Doctor, stock for Telma 40mg is low. We have Telpres 40mg in stock. Can we dispense that for Arun Kumar?',
          time: '09:42 AM',
          status: 'delivered',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      contactName: 'Clinical Diagnostic Lab',
      category: 'Lab',
      preview: 'Critical Alert: Patient Mary Jeni WBC elevated at 14,500.',
      time: '09:31 AM',
      unreadCount: 1,
      online: true,
      messages: [
        {
          sender: 'staff',
          text: 'Flagged CBC report for Mary Jeni (MHK202500322). WBC is 14,500 with neutrophilia.',
          time: '09:31 AM',
          status: 'read',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      contactName: 'Arun Kumar',
      uhid: 'MHK202500321',
      age: 45,
      gender: 'Male',
      category: 'Patient',
      preview: 'Thank you Doctor. I will report for the fasting sugar test tomorrow.',
      time: '09:15 AM',
      unreadCount: 0,
      online: true,
      condition: 'Diabetes • Hypertension',
      messages: [
        {
          sender: 'patient',
          text: 'Good morning Doctor. What time should I report for the fasting blood test tomorrow?',
          time: '09:10 AM',
          status: 'read',
        },
        {
          sender: 'doctor',
          text: 'Good morning Arun. Please report between 7:30 AM and 8:30 AM after 10-12 hours of overnight fasting.',
          time: '09:12 AM',
          status: 'delivered',
        },
        {
          sender: 'patient',
          text: 'Thank you Doctor. I will report for the fasting sugar test tomorrow.',
          time: '09:15 AM',
          status: 'read',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await messagesCol.insertMany(threads);
  console.log(`✅ ${threads.length} message threads seeded`);

  console.log('🎉 Seeding successfully completed!');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
