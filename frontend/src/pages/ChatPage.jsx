import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Clock3, RotateCcw, SendHorizonal, Sparkles } from 'lucide-react';
import api from '../api/client';
import SectionHeader from '../components/SectionHeader';

const quickPrompts = [
  'What is Paracetamol used for?',
  'Can I take Ibuprofen on an empty stomach?',
  'What should I do for mild fever and headache?',
  'Explain common side effects of antibiotics.'
];

const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

const ChatPage = () => {
  const [message, setMessage] = useState('');
  const [conversation, setConversation] = useState([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);

  const historyPayload = useMemo(
    () => conversation.map((item) => ({ role: item.role, text: item.text })).slice(-10),
    [conversation]
  );

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [conversation, loading]);

  const send = async (preset) => {
    const outgoing = (preset ?? message).trim();
    if (!outgoing || loading) return;

    const userMessage = {
      role: 'user',
      text: outgoing,
      createdAt: new Date().toISOString()
    };

    setConversation((prev) => [...prev, userMessage]);
    setMessage('');
    setLoading(true);

    try {
      const payloadHistory = [...historyPayload, { role: 'user', text: outgoing }].slice(-10);
      const { data } = await api.post('/ai/chat', { message: outgoing, history: payloadHistory });
      setConversation((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: data.data.text,
          createdAt: new Date().toISOString(),
          fallback: Boolean(data.data.fallback)
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const onInputKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const clearChat = () => setConversation([]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <SectionHeader
        eyebrow="MedVision Assistant"
        title="AI Chatbot Assistant"
        description="Ask medicine-related educational questions and receive safe guidance with contextual suggestions."
        action={
          <button onClick={clearChat} className="btn-secondary flex items-center gap-2 text-sm">
            <RotateCcw className="h-4 w-4" /> Clear Chat
          </button>
        }
      />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="panel rounded-2xl p-4"
      >
        <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
          <Sparkles className="h-4 w-4" /> Quick Prompts
        </p>
        <div className="flex flex-wrap gap-2">
          {quickPrompts.map((prompt) => (
            <button
              key={prompt}
              onClick={() => send(prompt)}
              className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-xs text-slate-200 transition hover:-translate-y-0.5 hover:border-cyan-400/30 hover:bg-slate-800"
            >
              {prompt}
            </button>
          ))}
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.05 }}
        ref={listRef}
        className="panel relative h-[500px] space-y-3 overflow-auto rounded-2xl p-4"
      >
        <div className="pointer-events-none absolute left-0 right-0 top-0 h-16 bg-gradient-to-b from-slate-900/70 to-transparent" />
        {!conversation.length && !loading ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <motion.div
              animate={{ y: [0, -6, 0], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="mb-3 rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-3"
            >
              <Bot className="h-8 w-8 text-cyan-300" />
            </motion.div>
            <p className="text-sm text-slate-300">Start a chat to get medicine guidance and safety tips.</p>
            <p className="mt-2 text-xs subtle">Ask symptoms, medicines, precautions, and usage questions.</p>
          </div>
        ) : null}

        <AnimatePresence initial={false}>
          {conversation.map((c, i) => (
            <motion.div
              key={`${c.role}-${i}`}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                c.role === 'user'
                  ? 'ml-auto bg-gradient-to-r from-cyan-500 to-blue-600 font-medium text-white shadow-lg shadow-cyan-700/20'
                  : 'border border-white/10 bg-slate-900 text-slate-100'
              }`}
            >
              <p className="whitespace-pre-wrap leading-relaxed">{c.text}</p>
              <div className="mt-2 flex items-center gap-2 text-[10px] opacity-70">
                <Clock3 className="h-3 w-3" />
                <span>{formatTime(c.createdAt)}</span>
                {c.role === 'assistant' && c.fallback ? (
                  <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                    Offline-safe mode
                  </span>
                ) : null}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {loading ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-fit rounded-xl border border-white/10 bg-slate-900 px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <Bot className="h-4 w-4 text-cyan-300" />
              <div className="typing-dots">
                <span />
                <span />
                <span />
              </div>
              <p className="text-xs subtle">MedVision AI is thinking...</p>
            </div>
          </motion.div>
        ) : null}
      </motion.div>

      <div className="flex gap-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Ask medicine-related question..."
          className="input-dark max-h-40 min-h-[52px] flex-1 resize-y"
        />
        <button
          onClick={() => send()}
          className="btn-primary flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
        >
          <SendHorizonal className="h-4 w-4" /> Send
        </button>
      </div>
    </div>
  );
};

export default ChatPage;