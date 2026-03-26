import { useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

const BarcodeScanner = ({ onDetected }) => {
  const videoRef = useRef(null);
  const [reading, setReading] = useState(false);

  const startScan = async () => {
    const reader = new BrowserMultiFormatReader();
    setReading(true);
    try {
      const result = await reader.decodeOnceFromVideoDevice(undefined, videoRef.current);
      onDetected(result.getText());
    } catch {
      onDetected('');
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="panel rounded-2xl p-4">
      <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Barcode Scanner</p>
      <video ref={videoRef} className="h-56 w-full rounded-xl border border-white/10 bg-black/30" />
      <button onClick={startScan} className="btn-primary mt-4 w-full">
        {reading ? 'Scanning...' : 'Scan Barcode'}
      </button>
    </div>
  );
};

export default BarcodeScanner;