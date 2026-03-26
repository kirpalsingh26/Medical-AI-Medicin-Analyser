import { Mic } from 'lucide-react';

const VoiceInput = ({ onTranscript }) => {
  const handleVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      onTranscript(transcript);
    };
    recognition.start();
  };

  return (
    <button
      onClick={handleVoice}
      className="rounded-xl border border-indigo-400/30 bg-indigo-500/20 p-3 text-indigo-200 transition hover:scale-[1.03] hover:bg-indigo-500/30"
    >
      <Mic className="h-5 w-5" />
    </button>
  );
};

export default VoiceInput;