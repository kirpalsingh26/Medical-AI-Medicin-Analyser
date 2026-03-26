import { motion } from 'framer-motion';

const SectionHeader = ({ eyebrow, title, description, action }) => {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="panel rounded-3xl p-7"
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          {eyebrow ? <p className="badge">{eyebrow}</p> : null}
          <h1 className="mt-3 text-3xl font-extrabold text-white md:text-4xl">{title}</h1>
          {description ? <p className="mt-2 max-w-2xl subtle">{description}</p> : null}
        </div>
        {action ? <div>{action}</div> : null}
      </div>
    </motion.section>
  );
};

export default SectionHeader;