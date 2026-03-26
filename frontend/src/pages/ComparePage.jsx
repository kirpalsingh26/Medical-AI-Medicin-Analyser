import { useState } from 'react';
import { ArrowRightLeft, BadgeCheck, FlaskConical, ShieldAlert, Sparkles, Stethoscope } from 'lucide-react';
import api from '../api/client';
import Loader from '../components/Loader';
import SearchAutocomplete from '../components/SearchAutocomplete';
import SectionHeader from '../components/SectionHeader';

const ComparePage = () => {
  const [medicineA, setMedicineA] = useState('');
  const [medicineB, setMedicineB] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [alternativesA, setAlternativesA] = useState('');
  const [alternativesB, setAlternativesB] = useState('');
  const [error, setError] = useState('');
  const [suggestionsA, setSuggestionsA] = useState([]);
  const [suggestionsB, setSuggestionsB] = useState([]);

  const compare = async () => {
    setError('');
    setResult(null);
    setAlternativesA('');
    setAlternativesB('');
    setSuggestionsA([]);
    setSuggestionsB([]);

    const a = medicineA.trim();
    const b = medicineB.trim();

    if (!a || !b) {
      setError('Please enter both medicines to compare.');
      return;
    }

    if (a.toLowerCase() === b.toLowerCase()) {
      setError('Choose two different medicines for meaningful comparison.');
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.post('/medicines/compare', { medicineA: a, medicineB: b });
      setResult(data.data);

      try {
        const medA = data.data?.a?.name || a;
        const medB = data.data?.b?.name || b;
        const [altA, altB] = await Promise.all([
          api.post('/ai/alternatives', { medicineName: medA }),
          api.post('/ai/alternatives', { medicineName: medB })
        ]);

        setAlternativesA(altA.data?.data?.text || 'No AI alternatives available for Medicine A right now.');
        setAlternativesB(altB.data?.data?.text || 'No AI alternatives available for Medicine B right now.');
      } catch {
        setAlternativesA('AI alternatives are temporarily unavailable. Please consult your doctor/pharmacist for substitutions.');
        setAlternativesB('AI alternatives are temporarily unavailable. Please consult your doctor/pharmacist for substitutions.');
      }
    } catch (err) {
      setError(err?.response?.data?.message || 'Unable to compare medicines right now.');

      try {
        const [nearA, nearB] = await Promise.all([
          api.get(`/medicines/autocomplete?q=${encodeURIComponent(a)}&limit=6`),
          api.get(`/medicines/autocomplete?q=${encodeURIComponent(b)}&limit=6`)
        ]);
        setSuggestionsA(nearA.data?.data || []);
        setSuggestionsB(nearB.data?.data || []);
      } catch {
        setSuggestionsA([]);
        setSuggestionsB([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const swapMedicines = () => {
    setMedicineA(medicineB);
    setMedicineB(medicineA);
  };

  const resetCompare = () => {
    setMedicineA('');
    setMedicineB('');
    setResult(null);
    setError('');
    setAlternativesA('');
    setAlternativesB('');
    setSuggestionsA([]);
    setSuggestionsB([]);
  };

  const scores = result?.comparison?.scores;

  const ScoreCard = ({ label, value, tone = 'text-cyan-300' }) => (
    <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-extrabold ${tone}`}>{value}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <SectionHeader
        eyebrow="Clinical Comparison"
        title="Medicine Comparison Tool"
        description="Compare medicine profile, category and risk overlap, then generate AI-backed substitution guidance."
        action={(
          <div className="flex items-center gap-2">
            <button className="btn-secondary inline-flex items-center gap-2" onClick={swapMedicines} type="button">
              <ArrowRightLeft className="h-4 w-4" /> Swap
            </button>
            <button className="btn-secondary" onClick={resetCompare} type="button">
              Reset
            </button>
          </div>
        )}
      />

      <div className="panel rounded-3xl p-5 md:p-6">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto] md:items-center">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Medicine A</p>
            <SearchAutocomplete
              value={medicineA}
              onChange={setMedicineA}
              onSelect={setMedicineA}
              placeholder="Type medicine A (shows catalog suggestions)"
              limit={300}
              showAllOnFocus
              onEnter={compare}
            />
          </div>
          <div className="hidden md:flex">
            <span className="rounded-xl border border-white/10 bg-slate-900/70 p-2 text-slate-300">
              <ArrowRightLeft className="h-4 w-4" />
            </span>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Medicine B</p>
            <SearchAutocomplete
              value={medicineB}
              onChange={setMedicineB}
              onSelect={setMedicineB}
              placeholder="Type medicine B (shows catalog suggestions)"
              limit={300}
              showAllOnFocus
              onEnter={compare}
            />
          </div>
          <button onClick={compare} className="btn-primary md:mt-6" disabled={loading || !medicineA.trim() || !medicineB.trim()}>
            {loading ? 'Comparing...' : 'Compare'}
          </button>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
        {(suggestionsA.length > 0 || suggestionsB.length > 0) && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-semibold text-slate-400">Suggestions for Medicine A</p>
              <div className="flex flex-wrap gap-2">
                {suggestionsA.map((item) => (
                  <button
                    key={`a-${item._id}`}
                    type="button"
                    onClick={() => setMedicineA(item.name)}
                    className="rounded-lg border border-white/10 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200 transition hover:border-cyan-500/40 hover:text-cyan-200"
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold text-slate-400">Suggestions for Medicine B</p>
              <div className="flex flex-wrap gap-2">
                {suggestionsB.map((item) => (
                  <button
                    key={`b-${item._id}`}
                    type="button"
                    onClick={() => setMedicineB(item.name)}
                    className="rounded-lg border border-white/10 bg-slate-900/80 px-2.5 py-1 text-xs text-slate-200 transition hover:border-cyan-500/40 hover:text-cyan-200"
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-400">Tip: focus either input to browse medicine suggestions from your catalog.</p>
      </div>

      {loading && <Loader text="Comparing and generating alternatives..." />}

      {result && (
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="panel rounded-2xl p-4">
            <h3 className="inline-flex items-center gap-2 text-lg font-bold text-white"><Stethoscope className="h-4 w-4 text-cyan-300" /> Medicine A</h3>
            <p className="mt-3 text-sm font-semibold text-slate-100">{result?.a?.name}</p>
            <p className="text-xs subtle">Generic: {result?.a?.genericName || 'N/A'}</p>
            <p className="text-xs subtle">Category: {result?.a?.category || 'N/A'}</p>
            <p className="mt-2 text-xs text-slate-300">Uses: {(result?.a?.uses || []).slice(0, 3).join(', ') || 'N/A'}</p>
            <p className="mt-1 text-xs text-slate-300">Side effects: {(result?.a?.sideEffects || []).slice(0, 3).join(', ') || 'N/A'}</p>
          </div>

          <div className="panel rounded-2xl p-4">
            <h3 className="inline-flex items-center gap-2 text-lg font-bold text-white"><Stethoscope className="h-4 w-4 text-indigo-300" /> Medicine B</h3>
            <p className="mt-3 text-sm font-semibold text-slate-100">{result?.b?.name}</p>
            <p className="text-xs subtle">Generic: {result?.b?.genericName || 'N/A'}</p>
            <p className="text-xs subtle">Category: {result?.b?.category || 'N/A'}</p>
            <p className="mt-2 text-xs text-slate-300">Uses: {(result?.b?.uses || []).slice(0, 3).join(', ') || 'N/A'}</p>
            <p className="mt-1 text-xs text-slate-300">Side effects: {(result?.b?.sideEffects || []).slice(0, 3).join(', ') || 'N/A'}</p>
          </div>

          <div className="panel rounded-2xl p-4 lg:col-span-1">
            <h3 className="inline-flex items-center gap-2 text-lg font-bold text-white"><FlaskConical className="h-4 w-4 text-indigo-300" /> Comparison Summary</h3>
            <div className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3">
              <p className="text-[10px] uppercase tracking-wide text-cyan-300">Overall similarity</p>
              <p className="mt-1 text-2xl font-extrabold text-cyan-200">{scores?.overallSimilarity != null ? `${scores.overallSimilarity}%` : 'N/A'}</p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500"
                  style={{ width: `${Math.max(0, Math.min(100, scores?.overallSimilarity || 0))}%` }}
                />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <ScoreCard label="Category" value={scores?.categorySimilarity != null ? `${scores.categorySimilarity}%` : 'N/A'} tone="text-cyan-300" />
              <ScoreCard label="Generic" value={scores?.genericSimilarity != null ? `${scores.genericSimilarity}%` : 'N/A'} tone="text-indigo-300" />
              <ScoreCard label="Use overlap" value={scores?.useOverlapPercent != null ? `${scores.useOverlapPercent}%` : 'N/A'} tone="text-emerald-300" />
              <ScoreCard label="Side-effect overlap" value={scores?.sideEffectOverlapPercent != null ? `${scores.sideEffectOverlapPercent}%` : 'N/A'} tone="text-amber-300" />
              <ScoreCard label="Alternative similarity" value={scores?.alternativeSimilarity != null ? `${scores.alternativeSimilarity}%` : 'N/A'} tone="text-fuchsia-300" />
              <ScoreCard label="Alt overlap" value={scores?.alternativeOverlapPercent != null ? `${scores.alternativeOverlapPercent}%` : 'N/A'} tone="text-violet-300" />
            </div>

            <div className="mt-3 space-y-2 text-xs">
              <p className="inline-flex items-center gap-2 text-slate-200">
                <BadgeCheck className="h-3.5 w-3.5 text-emerald-300" />
                Same category: {result?.comparison?.sameCategory ? 'Yes' : 'No'}
              </p>
              <p className="inline-flex items-center gap-2 text-slate-200">
                <BadgeCheck className="h-3.5 w-3.5 text-indigo-300" />
                Same generic: {result?.comparison?.sameGeneric ? 'Yes' : 'No'}
              </p>
              <p className="inline-flex items-center gap-2 text-slate-200">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-300" />
                Shared side effects: {(result?.comparison?.sideEffectOverlap || []).join(', ') || 'None'}
              </p>
              <p className="text-slate-300">
                Shared uses: {(result?.comparison?.useOverlap || []).join(', ') || 'None'}
              </p>
              <p className="text-slate-300">
                Shared alternatives: {(result?.comparison?.alternativeOverlap || []).join(', ') || 'None'}
              </p>
              <p className="text-slate-300">
                Cross-referenced alternatives: {result?.comparison?.alternativeCrossReference ? 'Yes' : 'No'}
              </p>
              <p className="text-slate-400">
                Match source: A {result?.meta?.matchedByA || 'n/a'} • B {result?.meta?.matchedByB || 'n/a'}
              </p>
            </div>
          </div>

          <div className="panel rounded-2xl p-4 lg:col-span-1">
            <h3 className="mb-2 inline-flex items-center gap-2 text-lg font-bold text-white"><Sparkles className="h-4 w-4 text-cyan-300" /> AI Alternatives for {result?.a?.name}</h3>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap pr-1 text-sm text-slate-300">{alternativesA}</p>
            <hr className="my-3 border-white/10" />
            <h4 className="mb-2 text-sm font-semibold text-slate-200">AI Alternatives for {result?.b?.name}</h4>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap pr-1 text-sm text-slate-300">{alternativesB}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ComparePage;