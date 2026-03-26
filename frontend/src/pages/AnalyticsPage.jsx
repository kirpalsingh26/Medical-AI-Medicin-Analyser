import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, BarChart3, CalendarDays, RefreshCcw, Search, Users } from 'lucide-react';
import api from '../api/client';
import SectionHeader from '../components/SectionHeader';

const AnalyticsPage = () => {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const loadAnalytics = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/analytics/summary');
      setAnalytics(res.data?.data || null);
    } catch (err) {
      setError(err?.response?.data?.message || 'Unable to load analytics summary.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAnalytics();
  }, []);

  const byDay = Array.isArray(analytics?.byDay) ? analytics.byDay : [];
  const maxDay = Math.max(...byDay.map((item) => item.count), 1);

  const points = byDay
    .map((item, idx) => {
      const x = (idx / Math.max(byDay.length - 1, 1)) * 100;
      const y = 100 - (item.count / maxDay) * 100;
      return `${x},${y}`;
    })
    .join(' ');

  const areaPoints = byDay.length ? `0,100 ${points} 100,100` : '';

  const topEvents = Array.isArray(analytics?.byEvent) ? analytics.byEvent : [];
  const maxEventCount = Math.max(...topEvents.map((item) => item.count), 1);
  const recentEvents = Array.isArray(analytics?.recentEvents) ? analytics.recentEvents : [];
  const filteredRecent = recentEvents.filter((item) => {
    const eventText = String(item?.event || '').toLowerCase();
    const userText = String(item?.user || '').toLowerCase();
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return eventText.includes(q) || userText.includes(q);
  });

  const formatDate = (isoDate) => {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return 'N/A';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const topEvent = topEvents[0];
  const topEventShare = analytics?.totalEvents
    ? Math.round(((topEvent?.count || 0) / analytics.totalEvents) * 100)
    : 0;
  const busiestDay = byDay.reduce((best, item) => (item.count > (best?.count || -1) ? item : best), null);

  const exportRecentCsv = () => {
    const rows = filteredRecent.map((item) => [
      item.event || '',
      item.user ? String(item.user) : 'guest',
      item.createdAt || ''
    ]);
    const header = ['event', 'user', 'createdAt'];
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'medvision-analytics-recent.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        eyebrow="Insights"
        title="Analytics Dashboard"
        description="Track event trends, engagement patterns, and operational activity with visual analytics."
        action={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportRecentCsv}
              className="btn-secondary"
              disabled={!filteredRecent.length}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={loadAnalytics}
              className="btn-secondary inline-flex items-center gap-2"
              disabled={loading}
            >
              <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        )}
      />

      {error ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p> : null}

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid gap-3 md:grid-cols-4">
        <div className="panel rounded-2xl bg-gradient-to-br from-cyan-500/10 to-transparent p-4 transition hover:-translate-y-0.5">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400"><Activity className="h-4 w-4 text-cyan-300" /> Total events</p>
          <h2 className="mt-2 text-3xl font-extrabold text-cyan-300">{analytics?.totalEvents ?? 0}</h2>
        </div>
        <div className="panel rounded-2xl bg-gradient-to-br from-indigo-500/10 to-transparent p-4 transition hover:-translate-y-0.5">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400"><BarChart3 className="h-4 w-4 text-indigo-300" /> Event types</p>
          <h2 className="mt-2 text-3xl font-extrabold text-indigo-300">{analytics?.metrics?.uniqueEventTypes ?? 0}</h2>
        </div>
        <div className="panel rounded-2xl bg-gradient-to-br from-emerald-500/10 to-transparent p-4 transition hover:-translate-y-0.5">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400"><CalendarDays className="h-4 w-4 text-emerald-300" /> Active days</p>
          <h2 className="mt-2 text-3xl font-extrabold text-emerald-300">{analytics?.metrics?.activeDays ?? 0}</h2>
        </div>
        <div className="panel rounded-2xl bg-gradient-to-br from-violet-500/10 to-transparent p-4 transition hover:-translate-y-0.5">
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400"><Users className="h-4 w-4 text-violet-300" /> Avg / active day</p>
          <h2 className="mt-2 text-3xl font-extrabold text-violet-300">{analytics?.metrics?.avgEventsPerActiveDay ?? 0}</h2>
        </div>
      </motion.div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="panel rounded-2xl p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">14-day activity trend</h3>
            <p className="text-xs text-slate-400">Peak event: {analytics?.metrics?.peakEvent || 'N/A'}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
            {byDay.length ? (
              <>
                <svg viewBox="0 0 100 100" className="h-44 w-full" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(34 211 238)" stopOpacity="0.35" />
                      <stop offset="100%" stopColor="rgb(34 211 238)" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  <line x1="0" y1="25" x2="100" y2="25" stroke="rgba(148,163,184,0.14)" strokeWidth="0.6" />
                  <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(148,163,184,0.14)" strokeWidth="0.6" />
                  <line x1="0" y1="75" x2="100" y2="75" stroke="rgba(148,163,184,0.14)" strokeWidth="0.6" />
                  <polygon points={areaPoints} fill="url(#trendFill)" />
                  <polyline
                    fill="none"
                    stroke="rgb(34 211 238)"
                    strokeWidth="2"
                    points={points}
                  />
                  {byDay.map((item, idx) => {
                    const x = (idx / Math.max(byDay.length - 1, 1)) * 100;
                    const y = 100 - (item.count / maxDay) * 100;
                    return <circle key={item.date} cx={x} cy={y} r="1.2" fill="rgb(125 211 252)" />;
                  })}
                </svg>
                <div className="mt-2 grid grid-cols-7 gap-1 text-[10px] text-slate-500">
                  {byDay.slice(-7).map((item) => (
                    <p key={item.date} className="truncate text-center">{formatDate(item.date)}</p>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-semibold text-cyan-300">
                    Max/day: {maxDay}
                  </span>
                  <span className="rounded-full border border-white/10 bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-slate-300">
                    14-day window
                  </span>
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">No trend data available.</p>
            )}
          </div>
        </div>

        <div className="panel rounded-2xl p-4">
          <h3 className="mb-3 text-lg font-bold text-white">Quick insights</h3>
          <div className="mb-3 rounded-xl border border-white/10 bg-slate-900/70 p-3">
            <p className="text-xs text-slate-400">Top event contribution</p>
            <p className="text-lg font-bold text-cyan-300">{topEventShare}%</p>
            <p className="text-xs text-slate-500">{topEvent?._id || 'N/A'}</p>
          </div>
          <div className="mb-3 rounded-xl border border-white/10 bg-slate-900/70 p-3">
            <p className="text-xs text-slate-400">Busiest day (14d)</p>
            <p className="text-lg font-bold text-emerald-300">{busiestDay ? `${formatDate(busiestDay.date)} • ${busiestDay.count}` : 'N/A'}</p>
          </div>
          <h4 className="mb-2 text-sm font-semibold text-slate-200">Top users by activity</h4>
          <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
            {(analytics?.topUsers || []).length ? (
              analytics.topUsers.map((item, idx) => (
                <div key={item.userId} className="rounded-xl border border-white/10 bg-slate-900/70 p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-xs text-slate-400">#{idx + 1}</p>
                    <p className="text-xs font-semibold text-cyan-300">{item.count} events</p>
                  </div>
                  <p className="truncate text-xs text-slate-300">{item.userId}</p>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-800">
                    <div
                      className="h-1.5 rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500"
                      style={{ width: `${Math.max(8, (item.count / Math.max((analytics?.topUsers?.[0]?.count || 1), 1)) * 100)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-400">No user activity yet.</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel rounded-2xl p-4">
          <h3 className="mb-3 text-lg font-bold text-white">Event distribution</h3>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {topEvents.length ? topEvents.map((item) => (
              <div key={item._id} className="rounded-lg border border-white/5 bg-slate-900/40 p-2.5">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <p className="truncate text-slate-300">{item._id}</p>
                  <p className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">{item.count}</p>
                </div>
                <div className="h-2 rounded-full bg-slate-800">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500"
                    style={{ width: `${Math.max(4, (item.count / maxEventCount) * 100)}%` }}
                  />
                </div>
              </div>
            )) : <p className="text-sm text-slate-400">No event distribution data.</p>}
          </div>
        </div>

        <div className="panel rounded-2xl p-4">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-lg font-bold text-white">Recent activity table</h3>
            <div className="analytics-input-wrap sm:w-64">
              <span className="analytics-input-icon">
                <Search className="h-4 w-4" />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by event/user"
                className="analytics-input-control"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-auto rounded-xl border border-white/10">
            <table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-slate-900/95 text-slate-400 backdrop-blur">
                <tr>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecent.length ? filteredRecent.map((item) => (
                  <tr key={item._id} className="border-t border-white/5 text-slate-300 odd:bg-slate-900/20 hover:bg-white/5">
                    <td className="px-3 py-2">
                      <span className="rounded-full border border-white/10 bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-200">{item.event}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{item.user ? String(item.user).slice(-6) : 'guest'}</td>
                    <td className="px-3 py-2 text-slate-400">{Number.isNaN(new Date(item.createdAt).getTime()) ? 'N/A' : new Date(item.createdAt).toLocaleString()}</td>
                  </tr>
                )) : (
                  <tr>
                    <td className="px-3 py-4 text-slate-400" colSpan={3}>{recentEvents.length ? 'No matching records.' : 'No recent events.'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {loading ? <p className="text-sm text-slate-400">Loading analytics...</p> : null}
    </div>
  );
};

export default AnalyticsPage;