import { geminiService } from '../services/geminiService.js';
import { SearchHistory } from '../models/SearchHistory.js';
import { medicineService } from '../services/medicineService.js';

const trivialChatPatterns = [
  /^hi+$/i,
  /^hello+$/i,
  /^hey+$/i,
  /^hii+$/i,
  /^how are (you|u)\??$/i,
  /^what'?s up\??$/i,
  /^ok(ay)?$/i,
  /^thanks!?$/i,
  /^thank you!?$/i,
  /^good (morning|afternoon|evening|night)$/i,
  /^yo+$/i
];

const isImportantChatMessage = (message) => {
  const normalized = String(message || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (normalized.length <= 3) return false;
  if (trivialChatPatterns.some((pattern) => pattern.test(normalized))) return false;

  return true;
};

const symptomFallbackRules = [
  {
    keywords: ['fever', 'temperature', 'high temp'],
    response:
      'For mild fever: hydrate well, rest, light meals, and monitor temperature every 4-6 hours. Seek urgent care if fever is very high, lasts more than 2-3 days, or comes with confusion, breathing issues, severe weakness, or persistent vomiting.'
  },
  {
    keywords: ['headache', 'migraine'],
    response:
      'For mild headache: hydrate, reduce screen strain, rest in a quiet room, and avoid skipping meals. Urgent review is needed for sudden severe headache, one-sided weakness, speech trouble, repeated vomiting, or head injury.'
  },
  {
    keywords: ['cough', 'cold', 'flu', 'sore throat'],
    response:
      'For cough/cold symptoms: warm fluids, adequate rest, steam inhalation, and avoid smoke exposure. Consult a doctor if breathing becomes difficult, chest pain appears, fever persists, or symptoms worsen after initial improvement.'
  },
  {
    keywords: ['stomach', 'gastric', 'acidity', 'diarrhea', 'vomit', 'nausea'],
    response:
      'For stomach-related symptoms: oral hydration, bland diet, and avoid oily/spicy foods. Get medical help quickly if there is blood in stool/vomit, severe dehydration, persistent abdominal pain, or symptoms lasting more than 24-48 hours.'
  },
  {
    keywords: ['allergy', 'rash', 'itching', 'hives'],
    response:
      'For mild allergy/rash: avoid trigger exposure and monitor progression. Emergency care is needed immediately for facial swelling, wheezing, throat tightness, breathing difficulty, or faintness.'
  }
];

const getSymptomFallback = (text) => {
  const lowered = String(text || '').toLowerCase();
  const matched = symptomFallbackRules.find((rule) => rule.keywords.some((k) => lowered.includes(k)));
  if (matched) return matched.response;

  return 'General guidance: rest, hydrate, avoid combining medicines without medical advice, and monitor symptoms. Seek immediate care for breathing trouble, chest pain, severe weakness, confusion, persistent high fever, or sudden worsening.';
};

export const generateInsights = async (req, res) => {
  const { medicineName, context } = req.body;
  const prompt = `You are a pharmaceutical assistant. Provide concise medical-safe educational insights for ${medicineName}. Context: ${context || 'none'}. Include uses, caution, common side effects, and when to consult a doctor. Avoid diagnosis.`;
  let response;
  let fallback = false;

  try {
    response = await geminiService.generate(prompt, { retries: 3 });
  } catch {
    fallback = true;
    const med = (await medicineService.search(medicineName))?.[0];
    if (med) {
      response = [
        `Medicine: ${med.name}`,
        `Common uses: ${(med.uses || []).join(', ') || 'Consult label/doctor.'}`,
        `Common side effects: ${(med.sideEffects || []).join(', ') || 'May vary by person.'}`,
        `Caution: Use only recommended dosage (${med.dosage || 'as prescribed'}).`,
        'If symptoms are severe, persistent, or unusual, consult a licensed doctor immediately.'
      ].join('\n');
    } else {
      response =
        'AI service is temporarily unavailable. Please consult a licensed healthcare professional for medicine-specific guidance.';
    }
  }

  if (req.user) {
    await SearchHistory.create({ user: req.user._id, query: medicineName, source: 'chatbot', resultCount: 1 });
  }

  res.status(200).json({ success: true, data: { text: response, fallback } });
};

export const alternativeSuggestions = async (req, res) => {
  const { medicineName } = req.body;
  const prompt = `Suggest practical OTC or doctor-consult alternatives for ${medicineName}. Return as plain bullet list with reason and caution.`;
  let response;
  let fallback = false;

  try {
    response = await geminiService.generate(prompt, { retries: 3 });
  } catch {
    fallback = true;
    const med = (await medicineService.search(medicineName))?.[0];
    const alternatives = med?.alternatives?.length
      ? med.alternatives.map((alt) => `- ${alt} (consult doctor/pharmacist before switching)`).join('\n')
      : '- No direct alternatives found in local data. Consult a doctor for substitution.';

    response = `${alternatives}\n- Do not self-switch medicines in chronic conditions without medical advice.`;
  }

  res.status(200).json({ success: true, data: { text: response, fallback } });
};

export const chatbot = async (req, res) => {
  const { message, history = [] } = req.body;
  const normalizedHistory = Array.isArray(history)
    ? history
        .slice(-8)
        .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text || ''}`)
        .join('\n')
    : '';

  const prompt = [
    'You are MedVision AI, an educational medical assistant for general health and medicine questions.',
    'Rules:',
    '- Be concise, clear, practical, and evidence-aligned.',
    '- Never provide diagnosis or guaranteed cure claims.',
    '- You can answer common medical questions, symptom education, medicine guidance, and prevention tips.',
    '- Include safety cautions and red-flag escalation when needed.',
    '- If a medicine is mentioned, explain general use, caution, and side effects in educational style.',
    '- For emergencies or severe symptoms, advise urgent in-person medical care.',
    '- End with a short disclaimer to consult a licensed healthcare professional for personalized treatment.',
    normalizedHistory ? `Conversation so far:\n${normalizedHistory}` : '',
    `Latest user message: ${message}`
  ]
    .filter(Boolean)
    .join('\n\n');

  let response;
  let fallback = false;

  try {
    response = await geminiService.generate(prompt, {
      retries: 3,
      temperature: 0.45,
      maxOutputTokens: 850
    });
  } catch {
    fallback = true;

    const candidateTokens = String(message || '')
      .split(/\s+/)
      .map((token) => token.replace(/[^a-zA-Z]/g, '').trim())
      .filter((token) => token.length >= 4)
      .slice(0, 10);

    let matchedMedicine = null;
    for (const token of candidateTokens) {
      const results = await medicineService.search(token);
      if (results.length) {
        matchedMedicine = results[0];
        break;
      }
    }

    if (matchedMedicine) {
      response = [
        `Educational guidance for ${matchedMedicine.name}:`,
        `• Common uses: ${(matchedMedicine.uses || []).join(', ') || 'Refer to label/doctor guidance.'}`,
        `• Common side effects: ${(matchedMedicine.sideEffects || []).join(', ') || 'Can vary by individual.'}`,
        `• Suggested dosage context: ${matchedMedicine.dosage || 'As prescribed by doctor.'}`,
        '• Safety: avoid combining medicines without professional advice.',
        'If severe symptoms (high fever, breathing trouble, chest pain, allergy signs) occur, seek immediate medical care.'
      ].join('\n');
    } else {
      response = getSymptomFallback(message);
    }

    response = `${response}\n\nThis is general educational information, not a diagnosis. Please consult a licensed healthcare professional for personalized treatment.`;
  }

  if (req.user && isImportantChatMessage(message)) {
    await SearchHistory.create({
      user: req.user._id,
      query: message.slice(0, 120),
      source: 'chatbot',
      resultCount: 1
    });
  }

  res.status(200).json({ success: true, data: { text: response, fallback } });
};