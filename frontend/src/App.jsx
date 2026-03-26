import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { motion } from 'framer-motion';
import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';
import Loader from './components/Loader';
import { useTheme } from './context/ThemeContext';

const AuthPage = lazy(() => import('./pages/AuthPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ScanPage = lazy(() => import('./pages/ScanPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));

const App = () => {
  const { dark } = useTheme();

  return (
    <div
      className={`relative min-h-full overflow-hidden ${
        dark
          ? 'bg-gradient-to-br from-[#020617] via-[#030712] to-[#0b1120]'
          : 'bg-gradient-to-br from-[#e6eef9] via-[#dfe7f5] to-[#d7e2f2]'
      }`}
    >
      <div className={`pointer-events-none absolute -top-20 left-8 h-72 w-72 rounded-full blur-3xl ${dark ? 'bg-cyan-500/10' : 'bg-cyan-500/20'}`} />
      <div className={`pointer-events-none absolute -right-20 top-1/3 h-80 w-80 rounded-full blur-3xl ${dark ? 'bg-indigo-500/10' : 'bg-indigo-500/20'}`} />
      <div
        className={`pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.05)_1px,transparent_1px)] bg-[size:30px_30px] ${dark ? 'opacity-20' : 'opacity-35'}`}
      />
      <Navbar />
      <motion.main
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="relative z-10 mx-auto max-w-7xl px-4 py-8"
      >
        <Suspense fallback={<Loader text="Preparing MedVision modules..." />}>
          <Routes>
            <Route path="/auth" element={<AuthPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/scan"
              element={
                <ProtectedRoute>
                  <ScanPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/compare"
              element={
                <ProtectedRoute>
                  <ComparePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/chat"
              element={
                <ProtectedRoute>
                  <ChatPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/analytics"
              element={
                <ProtectedRoute>
                  <AnalyticsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <ProfilePage />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </motion.main>
    </div>
  );
};

export default App;