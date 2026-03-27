import { useState } from 'react';
import { motion } from 'framer-motion';
import { Camera, FileImage, ScanLine, Settings2, Sparkles, WandSparkles } from 'lucide-react';
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
              className={`inline-block cursor-pointer rounded-xl border px-4 py-2 font-semibold transition ${
                dark
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
              className={`rounded-xl border px-4 py-2 font-semibold transition ${
                dark
                  ? 'border-rose-400/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                  : 'border-rose-400/50 bg-rose-50 text-rose-700 hover:bg-rose-100'
              }`}
            >
              Clear OCR
            </button>
            <button
              onClick={() => setShowAdvanced((p) => !p)}
              className={`rounded-xl border px-4 py-2 font-semibold transition ${
                dark
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
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    dark
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
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      dark
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

      const maxWidth = 1600;
      const scale = Math.min(1, maxWidth / image.width);
      canvas.width = Math.max(1, Math.floor(image.width * scale));
      canvas.height = Math.max(1, Math.floor(image.height * scale));

      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { data } = frame;

      for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const contrasted = Math.min(255, Math.max(0, (gray - 128) * 1.35 + 128));
        const bin = contrasted > 145 ? 255 : 0;
        data[i] = bin;
        data[i + 1] = bin;
        data[i + 2] = bin;
      }

      ctx.putImageData(frame, 0, 0);
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