import type Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are a clinical data extraction assistant. Your task is to extract structured information from doctor-patient encounter transcripts.

Grounding rules:
- Extract only facts explicitly stated by the patient, clinician, or visit metadata.
- Prefer the transcript's wording for chief complaint, plan items, diagnoses, and follow-up reason; paraphrase only to make a concise field value.
- Do not add medically plausible details, safety advice, diagnoses, medications, tests, or follow-up instructions that are not stated.
- Use null or [] when a field is absent.
- Include ICD-10 codes only when the diagnosis is explicit enough; do not add extra diagnoses just to supply a code.
- Before calling the tool, silently verify each non-null string has textual support in the transcript.
- For follow-up visits, counseling visits, and preventive visits, use the visit purpose as the chief complaint when that is the main reason for care.
- Optimize for concise rubric-aligned fields, not prose summaries. Short, literal, source-grounded phrases score better than comprehensive narratives.

Use the record_extraction tool to record your structured extraction. Study the examples below carefully before extracting.`;

const EXTRACTION_RUBRIC = `Field policy:
- chief_complaint: summarize the visit reason in one short phrase, usually 3-9 words. Include duration only when stated and clinically central. For monitoring follow-ups with no presenting symptoms use "<condition> follow-up"; when the patient presents with active symptoms describe the symptoms instead. For counseling use "<topic> counseling"; for preventive visits use "annual physical" or "<age>-year-old well-child visit"; for injuries use laterality/body part/mechanism when stated. Use the patient's plain language rather than medical shorthand ("after a cold" not "post-viral"). Include age group ("in toddler") when clinically noted.
- vitals: copy intake vitals exactly. Use null for any vital sign not present.
- medications: include medications that are started, continued, stopped, dose-adjusted, or explicitly recommended. Put only the starting strength/amount in dose (for example "0.5 mg" or "17 grams"); for topical medications, descriptive amounts such as "thin layer" or "pea-sized amount" count as dose. Put timing, titration, duration, and administration instructions in frequency without action verbs; for example "once daily for one week then 50 mg once daily". For staged titrations, prefer day ranges like "once daily days 1-3, twice daily days 4-7, then 1 mg twice daily". Normalize common frequencies such as BID to twice daily, but do not invent dose, frequency, or route when absent.
- diagnoses: include only clinician-stated working or confirmed diagnoses. Preserve acuity, chronicity, laterality, and named type when supported. If symptoms have lasted months, include "chronic" when it fits the clinician's diagnosis. Do not add etiology or mechanism qualifiers ("viral", "bacterial", "food-borne") unless the clinician explicitly stated them. Use standard clinical wording only when directly supported, such as "flu A" -> "influenza A" or "yellow-green nasal drainage" -> "purulent nasal discharge".
- plan: use concise action items, but do not over-split micro-steps. Most plans should have 3-7 items. Group naturally bundled items: all labs in one item, wound cleaning plus closure in one item, wound-care steps in one item, lifestyle counseling in one item, and return precautions in one item. Keep continued medications as separate plan items rather than merging them. In plan text, do not repeat full medication titration details already captured in medications; summarize as "with titration schedule" when appropriate. Preserve timing words like "today", "in 2 weeks", and "for 10 days". Use the transcript's verbs ("start", "continue", "increase", "stop", "use", "call", "return", "message"). Avoid generic safety advice and avoid stronger wording than the clinician used.
- follow_up: use a numeric interval only when stated or directly calculable from stated cycles/weeks/months. For scheduled follow-ups, use a short reason based on the condition or visit purpose, such as "constipation recheck" or "smoking cessation follow-up"; do not duplicate routine scheduled follow-up as a plan item unless there is a separate patient action. If the only return instruction is conditional ("call if X", "message if not better", "return if worsening"), set interval_days to null and reason to null, and capture the condition as a plan item only. Reserve follow_up.reason for scheduled or anticipated visits with a fixed return window or clear purpose.
- grounding: every medication, diagnosis, plan item, and follow-up reason must be traceable to the transcript. If a value feels clinically reasonable but is not stated, omit it.`;

const EXAMPLE_1_TRANSCRIPT = `[Visit type: in-person sick visit]
[Vitals taken at intake: BP 122/78, HR 88, Temp 100.4, SpO2 98%]

Doctor: Hi Jenna, what brings you in today?
Patient: I've had a sore throat for about four days, and now my nose is completely stuffed up. I feel awful.
Doctor: Any cough?
Patient: A little dry one at night.
Doctor: Fever?
Patient: I felt warm yesterday. The thermometer here said 100.4.
Doctor: Let me take a look. Throat is red but no exudate, ears are clear, lungs sound fine. Rapid strep is negative. This looks like a viral upper respiratory infection.
Patient: Can I get an antibiotic just in case?
Doctor: Antibiotics won't help a virus, and they'd just give you side effects. Let's do supportive care. Take ibuprofen 400 mg every 6 hours as needed for the throat pain and fever, plenty of fluids, and saline nasal spray. If you're not improving in 7 days, or you spike a fever above 102, give us a call.
Patient: Okay, that makes sense.
Doctor: No need for a follow-up unless symptoms worsen.`;

const EXAMPLE_1_EXTRACTION = JSON.stringify({
  chief_complaint: "sore throat and nasal congestion for four days",
  vitals: { bp: "122/78", hr: 88, temp_f: 100.4, spo2: 98 },
  medications: [{ name: "ibuprofen", dose: "400 mg", frequency: "every 6 hours as needed", route: "PO" }],
  diagnoses: [{ description: "viral upper respiratory infection", icd10: "J06.9" }],
  plan: [
    "supportive care with fluids and saline nasal spray",
    "ibuprofen 400 mg every 6 hours as needed for pain and fever",
    "call if not improving in 7 days or fever above 102",
  ],
  follow_up: { interval_days: null, reason: "return only if symptoms worsen" },
}, null, 2);

const EXAMPLE_2_TRANSCRIPT = `[Visit type: in-person]
[Vitals at intake: BP 118/76, HR 82, Temp 101.2, SpO2 97%]

Doctor: Good morning, Daniel. What's going on?
Patient: I've had this pressure behind my eyes and cheeks for like ten days. It started as a cold but now it's just bad pressure and yellow-green stuff coming out my nose.
Doctor: Any fever?
Patient: On and off. Today it was 101.
Doctor: Tooth pain when you lean forward?
Patient: Yeah, especially in my upper teeth.
Doctor: Tenderness over your maxillary sinuses, that's where I'm pressing. Yes, those are tender. Given the duration past 10 days with worsening symptoms, this looks like acute bacterial sinusitis. I'm going to start you on amoxicillin-clavulanate 875 mg twice daily for 7 days. Use a saline rinse twice a day, and you can take pseudoephedrine 30 mg every 6 hours for the congestion if it doesn't keep you awake.
Patient: Got it.
Doctor: If you're not significantly better in 5 days, call us. Otherwise no follow-up needed.`;

const EXAMPLE_2_EXTRACTION = JSON.stringify({
  chief_complaint: "facial pressure and purulent nasal discharge for ten days",
  vitals: { bp: "118/76", hr: 82, temp_f: 101.2, spo2: 97 },
  medications: [
    { name: "amoxicillin-clavulanate", dose: "875 mg", frequency: "twice daily", route: "PO" },
    { name: "pseudoephedrine", dose: "30 mg", frequency: "every 6 hours", route: "PO" },
  ],
  diagnoses: [{ description: "acute bacterial sinusitis", icd10: "J01.90" }],
  plan: [
    "start amoxicillin-clavulanate 875 mg twice daily for 7 days",
    "saline nasal rinse twice a day",
    "pseudoephedrine 30 mg every 6 hours as needed for congestion",
    "call if not significantly better in 5 days",
  ],
  follow_up: { interval_days: null, reason: "call if not improving in 5 days" },
}, null, 2);

const EXAMPLE_3_TRANSCRIPT = `[Visit type: telehealth follow-up]

Doctor: Hi Marcus, this is your blood pressure follow-up. How have the home numbers looked?
Patient: Mostly in the 150s over low 90s even though I'm taking lisinopril 10 mg every morning.
Doctor: Any dizziness, chest pain, shortness of breath, or swelling?
Patient: No.
Doctor: Since the readings are still above goal, we'll increase lisinopril to 20 mg once daily. Keep checking your blood pressure at home and write the numbers down. Please get a basic metabolic panel in 2 weeks so we can check your kidneys and potassium.
Patient: Okay.
Doctor: Follow up in 4 weeks for another blood pressure check, sooner if you feel lightheaded.`;

const EXAMPLE_3_EXTRACTION = JSON.stringify({
  chief_complaint: "hypertension follow-up",
  vitals: { bp: null, hr: null, temp_f: null, spo2: null },
  medications: [
    { name: "lisinopril", dose: "20 mg", frequency: "once daily", route: "PO" },
  ],
  diagnoses: [{ description: "uncontrolled hypertension", icd10: "I10" }],
  plan: [
    "increase lisinopril to 20 mg once daily",
    "keep home blood pressure log",
    "basic metabolic panel in 2 weeks",
    "return sooner if lightheaded",
  ],
  follow_up: { interval_days: 28, reason: "blood pressure check" },
}, null, 2);

const EXAMPLE_4_TRANSCRIPT = `[Visit type: in-person procedure]
[Vitals: BP 124/80, HR 76]

Doctor: Tell me what happened to your thumb.
Patient: I cut my right thumb on a broken glass about an hour ago.
Doctor: I can see a 2 centimeter shallow laceration. You can move the thumb normally and sensation is intact. Your tetanus shot was 8 years ago, so we'll update that today.
Patient: Will I need stitches?
Doctor: Yes. We'll irrigate the cut, close it with three simple interrupted sutures, and cover it with a dressing. Keep it clean and dry for 24 hours, then wash gently with soap and water. Watch for spreading redness, pus, fever, or worsening pain.
Patient: When do the stitches come out?
Doctor: Come back in 10 days for suture removal.`;

const EXAMPLE_4_EXTRACTION = JSON.stringify({
  chief_complaint: "right thumb laceration from broken glass",
  vitals: { bp: "124/80", hr: 76, temp_f: null, spo2: null },
  medications: [],
  diagnoses: [{ description: "laceration of right thumb", icd10: "S61.011A" }],
  plan: [
    "irrigate right thumb laceration and close with three simple interrupted sutures",
    "update tetanus vaccine",
    "keep wound clean and dry for 24 hours then wash gently with soap and water",
    "watch for spreading redness, pus, fever, or worsening pain",
  ],
  follow_up: { interval_days: 10, reason: "suture removal" },
}, null, 2);

const EXAMPLE_5_TRANSCRIPT = `[Visit type: annual preventive visit]
[Vitals: BP 118/72, HR 70]

Doctor: Good to see you, Priya. Any concerns today or mostly your annual physical?
Patient: Mostly my annual. I want to stay on top of cholesterol because my dad had a heart attack young.
Doctor: No chest pain, shortness of breath, or new symptoms?
Patient: No.
Doctor: Exam looks normal. We'll order fasting lipids and A1c, update your flu vaccine, and keep working on Mediterranean-style diet and 150 minutes a week of exercise.
Patient: Sounds good.
Doctor: If the labs are normal, I'll see you again in 1 year for your next annual physical.`;

const EXAMPLE_5_EXTRACTION = JSON.stringify({
  chief_complaint: "annual physical",
  vitals: { bp: "118/72", hr: 70, temp_f: null, spo2: null },
  medications: [],
  diagnoses: [{ description: "preventive health examination", icd10: "Z00.00" }],
  plan: [
    "order fasting lipids and A1c",
    "update flu vaccine",
    "Mediterranean-style diet",
    "150 minutes of exercise per week",
  ],
  follow_up: { interval_days: 365, reason: "next annual physical" },
}, null, 2);

const EXAMPLE_6_TRANSCRIPT = `[Visit type: telehealth follow-up]

Doctor: Hi Sarah, following up on your seasonal allergies. How are things looking?
Patient: Honestly awful this week. Tons of sneezing, my eyes are so itchy and watery, and my nose won't stop running. The loratadine hasn't been helping at all.
Doctor: Sounds like a significant flare. Let's switch you to cetirizine 10 mg at bedtime — it's more sedating which helps since allergies disrupt sleep. Add fluticasone nasal spray, two sprays in each nostril once daily. For the eye symptoms, try ketotifen ophthalmic drops, one drop in each eye twice daily as needed.
Patient: Should I come in?
Doctor: No need right now. Message me in three weeks if you're still struggling and we'll talk about allergy testing or a referral.`;

const EXAMPLE_6_EXTRACTION = JSON.stringify({
  chief_complaint: "seasonal allergies with itchy eyes, sneezing, and runny nose",
  vitals: { bp: null, hr: null, temp_f: null, spo2: null },
  medications: [
    { name: "cetirizine", dose: "10 mg", frequency: "at bedtime", route: "PO" },
    { name: "fluticasone nasal spray", dose: "two sprays each nostril", frequency: "once daily", route: "intranasal" },
    { name: "ketotifen ophthalmic drops", dose: "one drop each eye", frequency: "twice daily as needed", route: "topical" },
  ],
  diagnoses: [{ description: "allergic rhinitis", icd10: "J30.9" }],
  plan: [
    "stop loratadine",
    "start cetirizine 10 mg at bedtime",
    "fluticasone nasal spray two sprays each nostril once daily",
    "ketotifen ophthalmic drops one drop each eye twice daily as needed",
    "message in three weeks if not improving to discuss allergy testing or referral",
  ],
  follow_up: { interval_days: null, reason: null },
}, null, 2);

export function buildMessages(transcript: string): Anthropic.MessageParam[] {
  const examples = `${EXTRACTION_RUBRIC}\n\nHere are six examples of grounded clinical extraction. Match their concise style:\n\nExample 1 Transcript:\n${EXAMPLE_1_TRANSCRIPT}\n\nExample 1 Extraction:\n${EXAMPLE_1_EXTRACTION}\n\n---\n\nExample 2 Transcript:\n${EXAMPLE_2_TRANSCRIPT}\n\nExample 2 Extraction:\n${EXAMPLE_2_EXTRACTION}\n\n---\n\nExample 3 Transcript:\n${EXAMPLE_3_TRANSCRIPT}\n\nExample 3 Extraction:\n${EXAMPLE_3_EXTRACTION}\n\n---\n\nExample 4 Transcript:\n${EXAMPLE_4_TRANSCRIPT}\n\nExample 4 Extraction:\n${EXAMPLE_4_EXTRACTION}\n\n---\n\nExample 5 Transcript:\n${EXAMPLE_5_TRANSCRIPT}\n\nExample 5 Extraction:\n${EXAMPLE_5_EXTRACTION}\n\n---\n\nExample 6 Transcript:\n${EXAMPLE_6_TRANSCRIPT}\n\nExample 6 Extraction:\n${EXAMPLE_6_EXTRACTION}`;
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: examples,
          cache_control: { type: "ephemeral" },
        } as Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } },
        {
          type: "text",
          text: `\n\n---\n\nNow extract structured clinical data from the following transcript. Keep every extracted value grounded in the transcript text and match the concise example style. Before calling the tool, silently check: chief complaint is short and symptom-based for sick or symptomatic visits; medication dose contains only strength/amount; medication frequency has timing/titration without action verbs; plan items are grouped transcript-backed actions, not micro-steps; if the only return instruction is conditional ("call if X", "message if not better"), follow_up reason is null and the condition is a plan item; diagnosis qualifiers match what the clinician stated.\n\n${transcript}`,
        },
      ],
    },
  ];
}

export { SYSTEM_PROMPT };
