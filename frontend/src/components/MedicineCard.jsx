const MedicineCard = ({ medicine }) => (
  <article className="panel rounded-2xl p-5 transition duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:shadow-[0_0_40px_rgba(6,182,212,0.15)]">
    <h3 className="text-lg font-bold text-cyan-300">{medicine.name}</h3>
    <p className="mt-1 text-sm text-slate-400">Generic: {medicine.genericName || 'N/A'}</p>
    <div className="mt-4 space-y-1 text-sm text-slate-300">
      <p>Category: {medicine.category || 'N/A'}</p>
      <p>Dosage: {medicine.dosage || 'N/A'}</p>
    </div>
  </article>
);

export default MedicineCard;