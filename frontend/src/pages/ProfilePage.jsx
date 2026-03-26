import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, BarChart3, Bot, Clock3, LogOut, Mail, Mic, RefreshCcw, ScanLine, Trash2, UserRound } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import Loader from '../components/Loader';
import SectionHeader from '../components/SectionHeader';

const ProfilePage = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadProfileData = async () => {
    setLoading(true);
    setError('');

    try {
      const [dashboardRes, analyticsRes] = await Promise.allSettled([
        api.get('/dashboard/me'),
        api.get('/analytics/summary')
      ]);

      if (dashboardRes.status === 'fulfilled') {
        setDashboard(dashboardRes.value.data?.data || null);
      } else {
        setDashboard(null);
        setError('Unable to load dashboard activity.');
      }

      if (analyticsRes.status === 'fulfilled') {
        setAnalytics(analyticsRes.value.data?.data || null);
      } else {
        setAnalytics(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfileData();
  }, []);

  const initials = useMemo(() => {
    if (!user?.name) return 'MV';
    return user.name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }, [user]);

  const totalSearches = dashboard?.recentSearches?.length || 0;

  const userId = String(user?.id || user?._id || '');
  const sourceMap = useMemo(() => {
    const map = new Map();
    for (const item of dashboard?.sourceBreakdown || []) {
      map.set(item._id, item.count);
    }
    return map;
  }, [dashboard]);

  const aiChatCount = sourceMap.get('chatbot') || 0;
  const ocrCount = sourceMap.get('ocr') || 0;
  const voiceCount = sourceMap.get('voice') || 0;

  const userRecentAnalytics = useMemo(() => {
    const events = analytics?.recentEvents || [];
    if (!userId) return [];
    return events.filter((item) => String(item.user || '') === userId).slice(0, 8);
  }, [analytics, userId]);

  const byDay = analytics?.byDay || [];
  const maxByDay = Math.max(...byDay.map((item) => item.count), 1);

  const handleLogout = () => {
    logout();
    navigate('/auth');
  };

  const deleteSearch = async (id) => {
    setDashboard((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        recentSearches: prev.recentSearches.filter((item) => item._id !== id)
      };
    });

    try {
      await api.delete(`/dashboard/search/${id}`);
    } catch {
      const { data } = await api.get('/dashboard/me');
      setDashboard(data.data);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="My Profile"
        title="Account & Activity"
        description="View account details, monitor recent search behavior, and manage session actions."
        action={(
          <button
            type="button"
            onClick={loadProfileData}
            disabled={loading}
            className="btn-secondary inline-flex items-center gap-2"
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        )}
      />

      {error ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</p> : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="panel rounded-2xl p-6 lg:col-span-2">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 text-xl font-extrabold text-white">
              {initials}
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white">{user?.name || 'MedVision User'}</h2>
              <p className="text-sm text-slate-400">Manage your account settings and usage insights</p>
            </div>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
              <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                <UserRound className="h-4 w-4" /> Name
              </p>
              <p className="text-sm font-semibold text-slate-200">{user?.name || '-'}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
              <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                <Mail className="h-4 w-4" /> Email
              </p>
              <p className="text-sm font-semibold text-slate-200">{user?.email || '-'}</p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Source breakdown</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(dashboard?.sourceBreakdown || []).length ? (
                dashboard.sourceBreakdown.map((item) => (
                  <span key={item._id} className="rounded-full border border-white/10 bg-slate-900 px-2.5 py-1 text-xs text-slate-300">
                    {item._id}: <span className="font-semibold text-cyan-300">{item.count}</span>
                  </span>
                ))
              ) : (
                <span className="text-xs subtle">No source analytics yet.</span>
              )}
            </div>
          </div>
        </article>

        <aside className="panel rounded-2xl p-6">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Quick Actions</p>
          <button
            onClick={handleLogout}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/20 px-4 py-3 font-semibold text-rose-200 transition hover:bg-rose-500/30"
          >
            <LogOut className="h-4 w-4" /> Logout
          </button>
        </aside>
      </section>

      {loading ? (
        <Loader text="Loading profile activity..." />
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-4">
            <article className="panel rounded-2xl bg-gradient-to-br from-cyan-500/10 to-transparent p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Recent Searches</p>
              <p className="mt-2 text-3xl font-extrabold text-cyan-300">{totalSearches}</p>
            </article>
            <article className="panel rounded-2xl bg-gradient-to-br from-indigo-500/10 to-transparent p-5">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400"><Bot className="h-4 w-4 text-indigo-300" /> AI Chats</p>
              <p className="mt-2 text-3xl font-extrabold text-indigo-300">{aiChatCount}</p>
            </article>
            <article className="panel rounded-2xl bg-gradient-to-br from-emerald-500/10 to-transparent p-5">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400"><ScanLine className="h-4 w-4 text-emerald-300" /> OCR Scans</p>
              <p className="mt-2 text-3xl font-extrabold text-emerald-300">{ocrCount}</p>
            </article>
            <article className="panel rounded-2xl bg-gradient-to-br from-violet-500/10 to-transparent p-5">
              <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400"><Mic className="h-4 w-4 text-violet-300" /> Voice Queries</p>
              <p className="mt-2 text-3xl font-extrabold text-violet-300">{voiceCount}</p>
            </article>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            <article className="panel rounded-2xl p-5 lg:col-span-2">
              <p className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                <Activity className="h-4 w-4" /> Search Timeline
              </p>
              <ul className="space-y-2">
                {(dashboard?.recentSearches || []).slice(0, 8).map((search) => (
                  <li
                    key={search._id}
                    className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200"
                  >
                    <div>
                      <span className="font-semibold">{search.query}</span>
                      <span className="ml-2 rounded-full border border-white/10 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-400">{search.source}</span>
                      <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500">
                        <Clock3 className="h-3 w-3" />
                        {search.createdAt ? new Date(search.createdAt).toLocaleString() : 'N/A'}
                      </p>
                    </div>
                    <button
                      onClick={() => deleteSearch(search._id)}
                      className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-rose-200 transition hover:bg-rose-500/20"
                      title="Delete search"
                      aria-label="Delete search"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
                {!dashboard?.recentSearches?.length && (
                  <li className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-sm subtle">
                    No recent profile activity yet.
                  </li>
                )}
              </ul>
            </article>

            <aside className="panel rounded-2xl p-5">
              <p className="mb-3 inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                <BarChart3 className="h-4 w-4" /> Analysis Snapshot
              </p>
              <div className="space-y-2">
                <div className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Total events</p>
                  <p className="text-lg font-bold text-cyan-300">{analytics?.totalEvents ?? 0}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Event types</p>
                  <p className="text-lg font-bold text-indigo-300">{analytics?.metrics?.uniqueEventTypes ?? 0}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Peak event</p>
                  <p className="truncate text-sm font-semibold text-slate-200">{analytics?.metrics?.peakEvent || 'N/A'}</p>
                </div>
              </div>
            </aside>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="panel rounded-2xl p-5">
              <p className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">14-day Event Trend</p>
              <div className="flex h-36 items-end gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-3">
                {byDay.length ? byDay.map((item) => (
                  <div key={item.date} className="group flex-1">
                    <div
                      className="w-full rounded-t bg-gradient-to-t from-cyan-600 to-cyan-300/90 transition group-hover:from-cyan-500"
                      style={{ height: `${Math.max(5, (item.count / maxByDay) * 100)}%` }}
                      title={`${item.date}: ${item.count}`}
                    />
                  </div>
                )) : <p className="text-sm subtle">No trend data available.</p>}
              </div>
            </article>

            <article className="panel rounded-2xl p-5">
              <p className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">My Recent Analytics Activity</p>
              <div className="max-h-44 overflow-auto rounded-xl border border-white/10">
                <table className="min-w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-900/95 text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Event</th>
                      <th className="px-3 py-2">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userRecentAnalytics.length ? userRecentAnalytics.map((item) => (
                      <tr key={item._id} className="border-t border-white/5 text-slate-300 odd:bg-slate-900/20 hover:bg-white/5">
                        <td className="px-3 py-2">{item.event}</td>
                        <td className="px-3 py-2 text-slate-400">{new Date(item.createdAt).toLocaleString()}</td>
                      </tr>
                    )) : (
                      <tr>
                        <td className="px-3 py-3 subtle" colSpan={2}>No analytics events logged yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </>
      )}
    </div>
  );
};

export default ProfilePage;