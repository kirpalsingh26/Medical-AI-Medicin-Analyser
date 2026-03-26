import { motion } from 'framer-motion';

const Loader = ({ text = 'Loading MedVision...' }) => {
  return (
    <div className="panel flex items-center justify-center gap-4 py-8">
      <motion.div
        className="h-3 w-3 rounded-full bg-cyan-400"
        animate={{ y: [0, -10, 0], opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 0.8, repeat: Infinity }}
      />
      <motion.div
        className="h-3 w-3 rounded-full bg-teal-400"
        animate={{ y: [0, -10, 0], opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 0.8, repeat: Infinity, delay: 0.2 }}
      />
      <motion.div
        className="h-3 w-3 rounded-full bg-indigo-400"
        animate={{ y: [0, -10, 0], opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 0.8, repeat: Infinity, delay: 0.4 }}
      />
      <p className="text-sm text-slate-300">{text}</p>
    </div>
  );
};

export default Loader;