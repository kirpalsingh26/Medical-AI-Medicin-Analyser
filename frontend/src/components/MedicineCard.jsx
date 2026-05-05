import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Pill, User } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

const Badge = ({ children, color }) => {
  const colors = {
    cyan: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    violet: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
    emerald: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    amber: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${colors[color] || colors.cyan}`}>
      {children}
    </span>
  );
};

const ExpandableList = ({ items, label, color, dark }) => {
  const [expanded, setExpanded] = useState(false);
  if (!items?.length) return null;
  const visible = expanded ? items : items.slice(0, 3);
  return (
    <div className="mt-3">
      <p className={`mb-1 text-xs font-semibold uppercase tracking-wide ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
      <ul className="space-y-0.5">
        {visible.map((item, i) => (
          <li key={i} className={`text-sm ${dark ? 'text-slate-300' : 'text-slate-600'}`}>• {item}</li>
        ))}
      </ul>
      {items.length > 3 && (
        <button
          onClick={() => setExpanded(p => !p)}
          className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${dark ? 'text-cyan-400 hover:text-cyan-300' : 'text-cyan-600 hover:text-cyan-500'}`}
        >
          {expanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> +{items.length - 3} more</>}
        </button>
      )}
    </div>
  );
};

const MedicineCard = ({ medicine }) => {
  const { dark } = useTheme();
  const uses = typeof medicine.uses === 'string'
    ? medicine.uses.split(/[,;]/).map(s => s.trim()).filter(Boolean)
    : (medicine.uses || []);
  const sideEffects = typeof medicine.sideEffects === 'string'
    ? medicine.sideEffects.split(/[,;]/).map(s => s.trim()).filter(Boolean)
    : (medicine.sideEffects || []);
  const warnings = typeof medicine.warnings === 'string'
    ? medicine.warnings.split(/[,;]/).map(s => s.trim()).filter(Boolean)
    : (medicine.warnings || []);

  return (
    <article className={`panel rounded-2xl p-5 transition duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:shadow-[0_0_40px_rgba(6,182,212,0.15)] ${dark ? '' : 'bg-white/90'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className={`text-lg font-bold ${dark ? 'text-cyan-300' : 'text-cyan-700'}`}>{medicine.name}</h3>
          {medicine.genericName && (
            <p className={`mt-0.5 text-sm ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{medicine.genericName}</p>
          )}
        </div>
        <Pill className={`mt-1 h-5 w-5 shrink-0 ${dark ? 'text-cyan-500' : 'text-cyan-400'}`} />
      </div>

      {/* Badges */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {medicine.category && <Badge color="cyan">{medicine.category}</Badge>}
        {medicine.dosage && <Badge color="violet">{medicine.dosage}</Badge>}
        {medicine.manufacturer && (
          <span className={`inline-flex items-center gap-1 text-xs ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
            <User className="h-3 w-3" />{medicine.manufacturer}
          </span>
        )}
      </div>

      {/* Uses */}
      <ExpandableList items={uses} label="Uses" color="emerald" dark={dark} />

      {/* How to use */}
      {medicine.howToUse && (
        <div className="mt-3">
          <p className={`mb-1 text-xs font-semibold uppercase tracking-wide ${dark ? 'text-slate-400' : 'text-slate-500'}`}>How to use</p>
          <p className={`text-sm ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{medicine.howToUse}</p>
        </div>
      )}

      {/* Side Effects */}
      <ExpandableList items={sideEffects} label="Side Effects" color="amber" dark={dark} />

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mt-3">
          <p className={`mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide ${dark ? 'text-rose-400' : 'text-rose-500'}`}>
            <AlertTriangle className="h-3 w-3" /> Warnings
          </p>
          <ul className="space-y-0.5">
            {warnings.slice(0, 2).map((w, i) => (
              <li key={i} className={`text-sm ${dark ? 'text-rose-300' : 'text-rose-600'}`}>• {w}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
};

export default MedicineCard;