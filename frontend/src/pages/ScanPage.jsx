import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, BookOpen, Camera, FileImage, Info, Pill, ScanLine, Settings2, Sparkles, WandSparkles, Zap } from 'lucide-react';
import api from '../api/client';
import BarcodeScanner from '../components/BarcodeScanner';
import Loader from '../components/Loader';
import MedicineCard from '../components/MedicineCard';
import SearchAutocomplete from '../components/SearchAutocomplete';
import SectionHeader from '../components/SectionHeader';
import VoiceInput from '../components/VoiceInput';
import { useTheme } from '../context/ThemeContext';

const ScanPage = () => {
  const { dark } = useTheme();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ocrConfidence, setOcrConfidence] = useState(null);
  const [ocrCandidates, setOcrCandidates] = useState([]);
  const [ocrSuggestions, setOcrSuggestions] = useState([]);
  const [aiDetails, setAiDetails] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ocrMode, setOcrMode] = useState('balanced');
  const [minWordConfidence, setMinWordConfidence] = useState(42);
  const [maxNgram, setMaxNgram] = useState(3);
  const [ocrLang, setOcrLang] = useState('eng');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewName, setPreviewName] = useState('');

  const handleSearch = async (q = query) => {
    if (!q) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/medicines/search?q=${encodeURIComponent(q)}`);
      setResults(data.data || []);
    } finally {
      setLoading(false);
    }
  };

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreviewUrl(URL.createObjectURL(file));
    setPreviewName(file.name);
    const base64 = await preprocessImageToBase64(file);
    setLoading(true);
    try {
      const { data } = await api.post('/medicines/ocr-scan', {
        imageBase64: base64,
        lang: ocrLang,
        ocrOptions: {
          mode: ocrMode,
          minWordConfidence,
          maxNgram
        }
      });
      setOcrConfidence(data.data.confidence);
      setOcrCandidates(data.data.candidates || []);
      setOcrSuggestions(data.data.suggestions || []);
      setAiDetails(data.data.aiDetails || null);

      const fromDetected = (data.data.detectedMedicines || [])
        .map((item) => item.medicine)
        .filter(Boolean);

      const fromMatched = (data.data.matched || []).flatMap((m) => m.matches || []);
      const merged = dedupeMedicines([...fromDetected, ...fromMatched]);

      if (merged.length) {
        setResults(merged);
        setQuery(merged[0]?.name || '');
      } else {
        const bestCandidate = data.data.candidates?.[0];
        if (bestCandidate) {
          setQuery(bestCandidate);
          await handleSearch(bestCandidate);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const onBarcodeDetected = async (barcode) => {
    if (!barcode) return;
    const { data } = await api.get(`/medicines/barcode?barcode=${encodeURIComponent(barcode)}`);
    setResults(data.data ? [data.data] : []);
  };

  const clearOcr = () => {
    setOcrConfidence(null);
    setOcrCandidates([]);
    setOcrSuggestions([]);
    setAiDetails(null);
    setQuery('');
    setResults([]);
    setPreviewUrl('');
    setPreviewName('');
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Detection Lab"
        title="Medicine Detection Suite"
        description="Use OCR, barcode, and voice workflows with confidence scoring for fast medicine discovery."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <SearchAutocomplete value={query} onChange={setQuery} onSelect={(v) => setQuery(v)} />
        </div>
        <div className="flex gap-2">
          <button onClick={() => handleSearch()} className="btn-primary flex-1">
            Search
          </button>
          <VoiceInput onTranscript={(text) => { setQuery(text); handleSearch(text); }} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <motion.article
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="panel rounded-2xl p-5 lg:col-span-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input id="ocr-image-upload" type="file" accept="image/*" className="hidden" onChange={onFileChange} />
            <label
              htmlFor="ocr-image-upload"
              className={`inline-block cursor-pointer rounded-xl border px-4 py-2 font-semibold transition ${dark
                  ? 'border-indigo-400/30 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20'
                  : 'border-indigo-400/50 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                }`}
            >
              <span className="inline-flex items-center gap-2">
                <Camera className="h-4 w-4" /> Upload Prescription / Medicine Image
              </span>
            </label>
            <button
              onClick={clearOcr}
              className={`rounded-xl border px-4 py-2 font-semibold transition ${dark
                  ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                  : 'border-rose-400/50 bg-rose-50 text-rose-700 hover:bg-rose-100'
                }`}
            >
              Clear OCR
            </button>
            <button
              onClick={() => setShowAdvanced((p) => !p)}
              className={`rounded-xl border px-4 py-2 font-semibold transition ${dark
                  ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20'
                  : 'border-cyan-400/50 bg-cyan-50 text-cyan-700 hover:bg-cyan-100'
                }`}
            >
              <span className="inline-flex items-center gap-2">
                <Settings2 className="h-4 w-4" /> Advanced OCR
              </span>
            </button>
          </div>

          {showAdvanced && (
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs subtle">Mode</label>
                <select
                  value={ocrMode}
                  onChange={(e) => setOcrMode(e.target.value)}
                  className="input-dark py-2"
                >
                  <option value="fast">Fast</option>
                  <option value="balanced">Balanced</option>
                  <option value="accurate">Accurate</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs subtle">Language</label>
                <select
                  value={ocrLang}
                  onChange={(e) => setOcrLang(e.target.value)}
                  className="input-dark py-2"
                >
                  <option value="eng">English</option>
                  <option value="eng+hin">English + Hindi</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs subtle">Min word confidence: {minWordConfidence}</label>
                <input
                  type="range"
                  min={20}
                  max={80}
                  step={1}
                  value={minWordConfidence}
                  onChange={(e) => setMinWordConfidence(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs subtle">Token window: {maxNgram}</label>
                <input
                  type="range"
                  min={2}
                  max={4}
                  step={1}
                  value={maxNgram}
                  onChange={(e) => setMaxNgram(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}
          <p className="mt-2 text-xs subtle">Tip: upload a clear, focused image with good lighting for best OCR quality.</p>
          {!!ocrCandidates.length && (
            <div className="mt-3 flex flex-wrap gap-2">
              {ocrCandidates.slice(0, 8).map((candidate) => (
                <button
                  key={candidate}
                  onClick={() => {
                    setQuery(candidate);
                    handleSearch(candidate);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${dark
                      ? 'border-white/10 bg-slate-900 text-slate-200 hover:bg-slate-800'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                    }`}
                >
                  {candidate}
                </button>
              ))}
            </div>
          )}

          {!!ocrSuggestions.length && (
            <div className="mt-4">
              <p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
                <WandSparkles className="h-4 w-4" /> Suggestions
              </p>
              <div className="flex flex-wrap gap-2">
                {ocrSuggestions.map((item) => (
                  <button
                    key={`${item.name}-${item.basedOn}`}
                    onClick={() => {
                      setQuery(item.name);
                      handleSearch(item.name);
                    }}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${dark
                        ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20'
                        : 'border-cyan-400/50 bg-cyan-50 text-cyan-700 hover:bg-cyan-100'
                      }`}
                    title={`Based on OCR token: ${item.basedOn}`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </motion.article>

        <motion.aside
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 }}
          className="panel rounded-2xl p-5"
        >
          <p className="mb-3 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
            <FileImage className="h-4 w-4" /> OCR Snapshot
          </p>
          {previewUrl ? (
            <>
              <img src={previewUrl} alt="OCR preview" className="h-44 w-full rounded-xl border border-white/10 object-cover" />
              <p className={`mt-2 truncate text-xs ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{previewName}</p>
            </>
          ) : (
            <div className={`flex h-44 items-center justify-center rounded-xl border border-dashed text-center text-xs ${dark ? 'border-white/10 bg-slate-900/70' : 'border-slate-300 bg-white/70'}`}>
              Upload image to preview OCR input
            </div>
          )}

          <div className="mt-4 space-y-2">
            <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${dark ? 'border-white/10 bg-slate-900/70' : 'border-slate-300 bg-white/80'}`}>
              <span className="inline-flex items-center gap-2 text-xs subtle"><ScanLine className="h-4 w-4" /> OCR Confidence</span>
              <span className="text-sm font-bold text-emerald-400">{ocrConfidence !== null ? `${ocrConfidence}%` : '--'}</span>
            </div>
            <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${dark ? 'border-white/10 bg-slate-900/70' : 'border-slate-300 bg-white/80'}`}>
              <span className="text-xs subtle">Candidates</span>
              <span className="text-sm font-bold text-cyan-300">{ocrCandidates.length}</span>
            </div>
            <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${dark ? 'border-white/10 bg-slate-900/70' : 'border-slate-300 bg-white/80'}`}>
              <span className="inline-flex items-center gap-2 text-xs subtle"><Sparkles className="h-4 w-4" /> Suggestions</span>
              <span className="text-sm font-bold text-indigo-300">{ocrSuggestions.length}</span>
            </div>
          </div>
        </motion.aside>
      </section>

      <BarcodeScanner onDetected={onBarcodeDetected} />

      {/* ── Gemini AI Detail Card ──────────────────────────────────────────── */}
      <AnimatePresence>
        {aiDetails && (
          <motion.section
            key="ai-details"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`panel rounded-2xl p-6 ${dark ? 'bg-gradient-to-br from-indigo-950/60 to-slate-900/80 border border-indigo-500/20' : 'bg-gradient-to-br from-indigo-50 to-white border border-indigo-200'}`}
          >
            {/* Header */}
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className={`mb-1 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest ${dark ? 'text-indigo-300' : 'text-indigo-600'}`}>
                  <Zap className="h-3.5 w-3.5" /> Gemini AI Analysis
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${dark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}>
                    {aiDetails.source?.split(':')[0].toUpperCase()}
                  </span>
                </p>
                <h2 className={`text-2xl font-extrabold ${dark ? 'text-white' : 'text-slate-900'}`}>
                  {aiDetails.medicineName || 'Unknown Medicine'}
                </h2>
                {aiDetails.genericName && (
                  <p className={`mt-0.5 text-sm ${dark ? 'text-slate-300' : 'text-slate-600'}`}>
                    Generic: <span className="font-semibold">{aiDetails.genericName}</span>
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className={`rounded-xl px-3 py-1 text-sm font-bold ${aiDetails.confidence >= 75 ? (dark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700') : (dark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700')}`}>
                  {aiDetails.confidence}% confidence
                </span>
                {aiDetails.manufacturer && (
                  <span className={`text-xs ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{aiDetails.manufacturer}</span>
                )}
                {aiDetails.dosage && (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${dark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-100 text-cyan-700'}`}>
                    <Pill className="h-3 w-3" /> {aiDetails.dosage}
                  </span>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {/* Uses */}
              {aiDetails.uses?.length > 0 && (
                <div className={`rounded-xl p-4 ${dark ? 'bg-slate-800/60 border border-white/5' : 'bg-white border border-slate-200'}`}>
                  <p className={`mb-2 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider ${dark ? 'text-sky-300' : 'text-sky-700'}`}>
                    <BookOpen className="h-3.5 w-3.5" /> Uses / Indications
                  </p>
                  <ul className="space-y-1">
                    {aiDetails.uses.map((u, i) => (
                      <li key={i} className={`flex items-start gap-1.5 text-sm ${dark ? 'text-slate-200' : 'text-slate-700'}`}>
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                        {u}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Side Effects */}
              {aiDetails.sideEffects?.length > 0 && (
                <div className={`rounded-xl p-4 ${dark ? 'bg-slate-800/60 border border-white/5' : 'bg-white border border-slate-200'}`}>
                  <p className={`mb-2 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider ${dark ? 'text-rose-300' : 'text-rose-700'}`}>
                    <AlertTriangle className="h-3.5 w-3.5" /> Side Effects
                  </p>
                  <ul className="space-y-1">
                    {aiDetails.sideEffects.map((s, i) => (
                      <li key={i} className={`flex items-start gap-1.5 text-sm ${dark ? 'text-slate-200' : 'text-slate-700'}`}>
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* How to Use + Warnings */}
              <div className="space-y-3">
                {aiDetails.howToUse && (
                  <div className={`rounded-xl p-4 ${dark ? 'bg-slate-800/60 border border-white/5' : 'bg-white border border-slate-200'}`}>
                    <p className={`mb-1.5 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider ${dark ? 'text-emerald-300' : 'text-emerald-700'}`}>
                      <Info className="h-3.5 w-3.5" /> How to Use
                    </p>
                    <p className={`text-sm ${dark ? 'text-slate-200' : 'text-slate-700'}`}>{aiDetails.howToUse}</p>
                  </div>
                )}
                {aiDetails.warnings?.length > 0 && (
                  <div className={`rounded-xl p-4 ${dark ? 'bg-amber-950/40 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'}`}>
                    <p className={`mb-1.5 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider ${dark ? 'text-amber-300' : 'text-amber-700'}`}>
                      <AlertTriangle className="h-3.5 w-3.5" /> Warnings
                    </p>
                    <ul className="space-y-1">
                      {aiDetails.warnings.map((w, i) => (
                        <li key={i} className={`text-sm ${dark ? 'text-amber-100' : 'text-amber-800'}`}>• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            {/* Detected text */}
            {aiDetails.detectedText && (
              <details className="mt-4">
                <summary className={`cursor-pointer text-xs ${dark ? 'text-slate-400' : 'text-slate-500'} hover:underline`}>
                  Raw text detected on label
                </summary>
                <pre className={`mt-2 max-h-32 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap ${dark ? 'bg-slate-900 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
                  {aiDetails.detectedText}
                </pre>
              </details>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {loading ? (
        <Loader text="Analyzing medicine data..." />
      ) : (
        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {results.map((medicine) => (
            <MedicineCard key={medicine._id || medicine.name} medicine={medicine} />
          ))}
          {!results.length && (
            <div className={`panel col-span-full rounded-2xl border-dashed p-6 text-center text-sm subtle ${dark ? '' : 'bg-white/80'}`}>
              No medicine result yet. Try search, upload prescription image, voice input, or barcode scan.
            </div>
          )}
        </section>
      )}
    </div>
  );
};

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const preprocessImageToBase64 = async (file) => {
  const base64 = await fileToBase64(file);
  const imageUrl = `data:${file.type || 'image/png'};base64,${base64}`;

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas context not available'));

      // Only resize for bandwidth — server handles all preprocessing
      // (contrast, threshold, multi-variant, etc.) properly with sharp
      const maxWidth = 2400;
      const scale = Math.min(1, maxWidth / image.width);
      canvas.width = Math.max(1, Math.floor(image.width * scale));
      canvas.height = Math.max(1, Math.floor(image.height * scale));

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      const optimized = canvas.toDataURL('image/png').split(',')[1];
      resolve(optimized);
    };
    image.onerror = reject;
    image.src = imageUrl;
  });
};

const dedupeMedicines = (list) => {
  const map = new Map();
  for (const item of list) {
    if (!item) continue;
    const key = item._id || item.name;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
};

export default ScanPage;