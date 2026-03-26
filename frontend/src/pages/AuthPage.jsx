import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity,
  BarChart3,
  BrainCircuit,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  MessageSquareText,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  User
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const AuthPage = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isLogin) {
        await login(form.email, form.password);
      } else {
        await register(form.name, form.email, form.password);
      }
      navigate('/');
    } catch (err) {
      setError(err?.response?.data?.message || 'Authentication failed');
    }
  };

  return (
    <div className="mx-auto mt-10 grid max-w-5xl gap-4 lg:grid-cols-2">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="panel rounded-3xl p-7"
      >
        <p className="badge">Secure Access</p>
        <h1 className="mb-2 mt-4 text-3xl font-extrabold text-white">{isLogin ? 'Welcome Back' : 'Create Account'}</h1>
        <p className="mb-5 text-sm subtle">
          {isLogin
            ? 'Login to continue your AI medicine analysis workflow.'
            : 'Register to save OCR history, insights, and personalized dashboard data.'}
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          {!isLogin && (
            <div className="auth-input-wrap">
              <span className="auth-input-icon">
                <User />
              </span>
              <input
                placeholder="Name"
                className="auth-input-control"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
          )}
          <div className="auth-input-wrap">
            <span className="auth-input-icon">
              <Mail />
            </span>
            <input
              placeholder="Email"
              type="email"
              className="auth-input-control"
              value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
            />
          </div>
          <div className="auth-input-wrap">
            <span className="auth-input-icon">
              <LockKeyhole />
            </span>
            <input
              placeholder="Password"
              type={showPassword ? 'text' : 'password'}
              className="auth-input-control pr-12"
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
            />
            <button
              type="button"
              onClick={() => setShowPassword((p) => !p)}
              className="auth-input-action"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between text-xs">
            <label className="inline-flex items-center gap-2 text-slate-400">
              <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900" />
              Remember me
            </label>
            <span className="text-cyan-400">Secure JWT session</span>
          </div>
          {error && <p className="text-sm text-rose-500">{error}</p>}
          <button className="btn-primary w-full">
            {isLogin ? 'Login' : 'Register'}
          </button>
        </form>
        <button className="mt-4 text-sm font-medium text-cyan-400" onClick={() => setIsLogin((p) => !p)}>
          {isLogin ? 'New user? Register' : 'Already have an account? Login'}
        </button>

        <div className="mt-5 rounded-2xl border border-cyan-400/20 bg-cyan-500/5 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-300">AI Capability Highlights</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-white/10 bg-slate-900/80 p-2.5">
              <p className="inline-flex items-center gap-2 text-xs font-semibold text-slate-200"><ScanSearch className="h-3.5 w-3.5 text-cyan-300" /> OCR Scan</p>
              <p className="mt-1 text-[11px] subtle">Read labels and prescriptions.</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/80 p-2.5">
              <p className="inline-flex items-center gap-2 text-xs font-semibold text-slate-200"><BrainCircuit className="h-3.5 w-3.5 text-indigo-300" /> AI Insights</p>
              <p className="mt-1 text-[11px] subtle">Interpret medicine context quickly.</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/80 p-2.5">
              <p className="inline-flex items-center gap-2 text-xs font-semibold text-slate-200"><MessageSquareText className="h-3.5 w-3.5 text-emerald-300" /> AI Chat</p>
              <p className="mt-1 text-[11px] subtle">Ask medical workflow questions.</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/80 p-2.5">
              <p className="inline-flex items-center gap-2 text-xs font-semibold text-slate-200"><BarChart3 className="h-3.5 w-3.5 text-violet-300" /> Analytics</p>
              <p className="mt-1 text-[11px] subtle">Track search and scan trends.</p>
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Security</p>
            <p className="text-xs font-semibold text-emerald-300">High</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">AI Access</p>
            <p className="text-xs font-semibold text-cyan-300">Enabled</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">OCR Suite</p>
            <p className="text-xs font-semibold text-indigo-300">Ready</p>
          </div>
        </div>
      </motion.div>

      <motion.aside
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="panel hidden rounded-3xl p-7 lg:block"
      >
        <p className="badge">Why MedVision</p>
        <h2 className="mt-4 text-2xl font-extrabold text-white">AI-first medicine intelligence</h2>
        <p className="mt-2 text-sm subtle">Fast OCR, safety-focused chatbot, and personalized medical search dashboard.</p>

        <div className="mt-5 grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Medicine Profiles</p>
            <p className="text-sm font-bold text-cyan-300">10K+</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Core Modules</p>
            <p className="text-sm font-bold text-indigo-300">6</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Realtime AI</p>
            <p className="text-sm font-bold text-emerald-300">Active</p>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-200"><Sparkles className="h-4 w-4" /> Smarter OCR</p>
            <p className="mt-1 text-xs subtle">Detect medicines from labels and prescriptions with confidence scoring.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-200"><ShieldCheck className="h-4 w-4" /> Responsible AI</p>
            <p className="mt-1 text-xs subtle">Safe educational guidance with fallback reliability.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/70 p-4">
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-indigo-200"><Activity className="h-4 w-4" /> Guided Workflow</p>
            <div className="mt-2 space-y-1.5 text-[11px] subtle">
              <p>1. Scan or search medicine name</p>
              <p>2. Get AI-powered explanation and risks</p>
              <p>3. Compare alternatives and track analytics</p>
            </div>
          </div>
        </div>
      </motion.aside>
    </div>
  );
};

export default AuthPage;