import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface SignaturePadProps {
  open: boolean;
  onCancel: () => void;
  onSave: (signatureData: string) => void;
}

export function SignaturePad({ open, onCancel, onSave }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const pointCountRef = useRef(0);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    if (!open) return;
    const prepareCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 3.2;
      context.strokeStyle = "#102c2d";
      pointCountRef.current = 0;
      setHasInk(false);
    };
    const frame = requestAnimationFrame(prepareCanvas);
    window.addEventListener("resize", prepareCanvas);
    document.addEventListener("fullscreenchange", prepareCanvas);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", prepareCanvas);
      document.removeEventListener("fullscreenchange", prepareCanvas);
    };
  }, [open]);

  if (!open) return null;

  const coordinates = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const point = coordinates(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
    drawingRef.current = true;
  };

  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    event.preventDefault();
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const point = coordinates(event);
    context.lineTo(point.x, point.y);
    context.stroke();
    pointCountRef.current += 1;
    if (pointCountRef.current >= 8) setHasInk(true);
  };

  const endStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    pointCountRef.current = 0;
    setHasInk(false);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    onSave(canvas.toDataURL("image/png"));
  };

  return (
    <section className="signature-overlay" role="dialog" aria-modal="true" aria-labelledby="signature-title">
      <header className="signature-header">
        <div>
          <span>知情同意</span>
          <h1 id="signature-title">请在下方手写签名</h1>
        </div>
        <p>使用手指或触控笔连续书写；签名仅保存在主试电脑中。</p>
      </header>
      <div className="signature-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="signature-canvas"
          aria-label="手写签名区域"
          onPointerDown={startStroke}
          onPointerMove={continueStroke}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
        {!hasInk && <div className="signature-guide" aria-hidden="true">请在此处签名</div>}
      </div>
      <footer className="signature-actions">
        <button type="button" className="signature-secondary" onClick={onCancel}>取消</button>
        <button type="button" className="signature-secondary" onClick={clear}>清除</button>
        <button type="button" className="primary-button" disabled={!hasInk} onClick={save}>保存签名</button>
      </footer>
    </section>
  );
}
