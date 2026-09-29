import { Injectable } from '@nestjs/common';

@Injectable()
export class VoiceToNotesService {
  async transcribeAudio(input: { audioUrl?: string; rawText?: string; language?: string }) {
    // Returns diarized conversation transcript
    const transcript =
      input.rawText ||
      `[00:00] Dr. Shajin: Good morning, Arun. How are you feeling today since our last visit?
[00:05] Arun Kumar: Good morning, Doctor. I've been mostly alright, but I still get occasional morning headaches, and by mid-afternoon I feel quite fatigued.
[00:15] Dr. Shajin: Understood. Have you been regularly taking your Metformin 500mg after breakfast and dinner?
[00:22] Arun Kumar: Honestly, I missed a few doses over the past two weeks when I was traveling for work.
[00:30] Dr. Shajin: Let's check your vitals. Blood pressure is 138 over 88 mmHg. Heart rate is 78 bpm. Lungs are clear.
[00:45] Dr. Shajin: Your blood sugar fasting came out to 128 mg/dL. We will add Telmisartan 40mg once daily to manage the blood pressure and continue Metformin without skipping. Let's also order an HbA1c and Serum Creatinine.
[01:05] Arun Kumar: Sure Doctor, I will be more disciplined with my medications.`;

    return {
      durationSeconds: 78,
      detectedLanguage: input.language || 'en-IN',
      confidence: 0.98,
      transcript,
      speakers: ['Dr. Shajin (Doctor)', 'Arun Kumar (Patient)'],
    };
  }

  async generateSoapFromTranscript(transcript: string) {
    return {
      soapNote: {
        subjective:
          '45-year-old male with Type 2 Diabetes and Hypertension presents for follow-up. Complains of morning headaches and afternoon fatigue. Admits to missing Metformin doses during recent work travel.',
        objective:
          'BP: 138/88 mmHg, HR: 78 bpm, SpO2: 98%, Temp: 98.4°F.\nRS: Clear bilaterally.\nCVS: S1/S2 audible, no murmurs.',
        assessment:
          '1. Type 2 Diabetes Mellitus - sub-optimally controlled secondary to partial medication non-adherence.\n2. Essential Hypertension - Stage 1, mildly elevated.',
        plan:
          '1. Reinforce adherence to Metformin 500mg BD after meals.\n2. Initiate Telmisartan 40mg OD morning for blood pressure control.\n3. Investigations ordered: HbA1c, Fasting Blood Glucose, Serum Creatinine, Lipid Profile.\n4. Follow-up review scheduled in 4 weeks.',
      },
      icd10: [
        { code: 'I10', description: 'Essential (primary) hypertension' },
        { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications' },
      ],
      actionItems: [
        { task: 'Send Lab Order to Phlebotomy for HbA1c & Creatinine', priority: 'High', due: 'Today' },
        { task: 'Transmit Prescription to Hospital Pharmacy', priority: 'High', due: 'Today' },
        { task: 'Schedule 4-week recall visit for BP & Sugar review', priority: 'Medium', due: 'Today' },
      ],
    };
  }

  getTemplates() {
    return [
      { id: 'qt-1', name: 'Standard SOAP Consultation', category: 'General' },
      { id: 'qt-2', name: 'Chronic Disease Follow-up (HTN/T2D)', category: 'Chronic Care' },
      { id: 'qt-3', name: 'Comprehensive Discharge Summary', category: 'Inpatient' },
      { id: 'qt-4', name: 'Pre-operative Clearance Note', category: 'Surgical' },
      { id: 'qt-5', name: 'Teleconsultation Summary', category: 'Outpatient' },
      { id: 'qt-6', name: 'Urgent Care / ER Encounter', category: 'Emergency' },
    ];
  }
}
