import { useEffect, useState } from 'react';
import api from '../api/client';
import { useDebounce } from '../hooks/useDebounce';

const SearchAutocomplete = ({
  value,
  onChange,
  onSelect,
  placeholder = 'Search medicine...',
  limit = 8,
  showAllOnFocus = false,
  onEnter
}) => {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const q = useDebounce(value, 300);

  useEffect(() => {
    const fetchAutocomplete = async () => {
      if (!q) {
        if (!showAllOnFocus || !open) {
          setItems([]);
          return;
        }
      }

      const params = new URLSearchParams();
      if (q) params.set('q', q);
      params.set('limit', String(limit));
      if (!q && showAllOnFocus && open) params.set('includeAll', 'true');

      try {
        const { data } = await api.get(`/medicines/autocomplete?${params.toString()}`);
        setItems(data.data || []);
      } catch {
        setItems([]);
      }
    };

    fetchAutocomplete();
  }, [q, open, showAllOnFocus, limit]);

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (onEnter) onEnter();
          }
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={placeholder}
        className="input-dark"
      />
      {open && items.length > 0 && (
        <ul className="absolute z-10 mt-2 max-h-72 w-full overflow-y-auto overflow-x-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
          {items.map((item) => (
            <li
              key={item._id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(item.name);
                setOpen(false);
              }}
              className="cursor-pointer border-b border-white/5 px-4 py-3 text-sm text-slate-200 transition last:border-b-0 hover:bg-slate-800"
            >
              <p className="font-medium text-slate-100">{item.name}</p>
              {(item.genericName || item.category) && (
                <p className="mt-0.5 text-xs text-slate-400">{[item.genericName, item.category].filter(Boolean).join(' • ')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default SearchAutocomplete;