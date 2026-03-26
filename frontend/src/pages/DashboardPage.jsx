import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Activity, Search, Trash2 } from 'lucide-react';
import api from '../api/client';
import SkeletonCard from '../components/SkeletonCard';
import SectionHeader from '../components/SectionHeader';

const DashboardPage = () => {
  const [data, setData] = useState(null);

  const loadDashboard = async () => {
    const res = await api.get('/dashboard/me');
    setData(res.data.data);
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  const deleteSearch = async (id) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        recentSearches: prev.recentSearches.filter((item) => item._id !== id)
      };
    });
    try {
      await api.delete(`/dashboard/search/${id}`);
      await loadDashboard();
    } catch {
      await loadDashboard();
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Command Center"
        title="MedVision Dashboard"
        description="AI-first pharmaceutical intelligence with OCR, voice, barcode, and chatbot workflows."
      />

      <section className="grid gap-4 md:grid-cols-3">
        <article className="panel rounded-2xl p-5">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-slate-400">
            <Search className="h-4 w-4" /> Total Recent Searches
          </p>
          <h3 className="mt-2 text-3xl font-extrabold text-cyan-300">{data?.recentSearches?.length ?? 0}</h3>
        </article>
        <article className="panel rounded-2xl p-5">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-slate-400">
            <Activity className="h-4 w-4" /> Search Sources
          </p>
          <h3 className="mt-2 text-3xl font-extrabold text-indigo-300">{data?.sourceBreakdown?.length ?? 0}</h3>
        </article>
        <article className="panel rounded-2xl p-5">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-400">Most Used Source</p>
          <h3 className="mt-2 text-2xl font-extrabold text-emerald-300">{data?.sourceBreakdown?.[0]?._id || '--'}</h3>
        </article>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {!data && (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}
        {data?.sourceBreakdown?.map((item) => (
          <motion.div
            key={item._id}
            whileHover={{ y: -4 }}
            className="panel rounded-2xl p-5"
          >
            <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Source</p>
            <h3 className="mt-2 text-2xl font-bold text-white">{item._id}</h3>
            <p className="mt-1 text-sm text-cyan-300">{item.count} searches</p>
          </motion.div>
        ))}
      </section>

      <section className="panel rounded-2xl p-5">
        <h2 className="mb-3 text-xl font-bold text-white">Recent Searches</h2>
        <ul className="space-y-2">
          {data?.recentSearches?.length ? data.recentSearches.map((s) => (
            <li key={s._id} className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-slate-200">
              <div>
                <span className="font-semibold">{s.query}</span>{' '}
                <span className="text-xs opacity-70">({s.source})</span>
              </div>
              <button
                onClick={() => deleteSearch(s._id)}
                className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-rose-200 transition hover:bg-rose-500/20"
                title="Delete search"
                aria-label="Delete search"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          )) : <li className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-sm subtle">No activity yet. Start scanning or searching medicines.</li>}
        </ul>
      </section>
    </div>
  );
};

export default DashboardPage;