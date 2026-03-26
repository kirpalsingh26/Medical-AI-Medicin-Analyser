import { Link, NavLink } from 'react-router-dom';
import { Menu, Moon, Sun, UserCircle2, X } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/scan', label: 'OCR Scan' },
  { to: '/compare', label: 'Compare' },
  { to: '/chat', label: 'AI Chat' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/profile', label: 'Profile' }
];

const Navbar = () => {
  const { user } = useAuth();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <header
      className={`sticky top-0 z-30 border-b backdrop-blur-xl ${
        dark ? 'border-white/10 bg-slate-950/80' : 'border-slate-300/80 bg-slate-100/80'
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
        <Link to="/" className={`flex items-center gap-2 text-xl font-extrabold tracking-wide ${dark ? 'text-white' : 'text-slate-900'}`}>
          <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_18px_#22d3ee]" />
          MEDVISION
        </Link>
        <nav className={`hidden gap-2 rounded-2xl border p-1 md:flex ${dark ? 'border-white/10 bg-slate-900/80' : 'border-slate-300 bg-white/80'}`}>
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                `rounded-xl px-4 py-2 text-sm font-medium transition ${
                  isActive
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-600/30'
                    : dark
                      ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                      : 'text-slate-700 hover:bg-slate-200 hover:text-slate-900'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            title="Toggle theme"
            className={`rounded-xl border p-2 transition ${dark ? 'border-white/10 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-200'}`}
          >
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          {user ? (
            <Link
              to="/profile"
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition ${dark ? 'border-white/10 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-200'}`}
            >
              <UserCircle2 className="h-4 w-4 text-cyan-300" />
              {user.name?.split(' ')[0] || 'Profile'}
            </Link>
          ) : (
            <Link to="/auth" className="btn-primary text-sm">
              Login
            </Link>
          )}
          <button
            onClick={() => setOpen((prev) => !prev)}
            className={`rounded-xl border p-2 transition md:hidden ${dark ? 'border-white/10 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-200'}`}
            aria-label="Toggle menu"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open ? (
        <div className={`mx-4 mb-4 rounded-2xl border p-2 md:hidden ${dark ? 'border-white/10 bg-slate-900/95' : 'border-slate-300 bg-white/95'}`}>
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `mb-1 block rounded-xl px-3 py-2 text-sm font-medium transition last:mb-0 ${
                  isActive
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white'
                    : dark
                      ? 'text-slate-300 hover:bg-slate-800 hover:text-white'
                      : 'text-slate-700 hover:bg-slate-200 hover:text-slate-900'
                }`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </header>
  );
};

export default Navbar;