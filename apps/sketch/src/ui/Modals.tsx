import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { app, type FileFormat } from '../app/store';
import type { Adjustment } from '../engine/adjust';
import { MAX_SIZE } from '../engine/document';
import { encodeDocument, FORMATS } from '../io/formats';
import * as platform from '../platform';

function Dialog(props: { title: string; children: ComponentChildren; onCancel: () => void; onConfirm?: () => void; side?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onCancel();
      } else if (e.key === 'Enter' && props.onConfirm && (e.target as HTMLElement).tagName !== 'BUTTON') {
        e.preventDefault();
        props.onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div class={`scrim${props.side ? ' side' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function SaveAsDialog(props: { initial: FileFormat; resolve: (v: { format: FileFormat; quality: number } | null) => void }) {
  const [format, setFormat] = useState<FileFormat>(props.initial);
  const [quality, setQuality] = useState(Math.round(app.lastQuality * 100));
  const [size, setSize] = useState<string>('…');
  const lossy = FORMATS[format].lossy;

  useEffect(() => {
    let cancelled = false;
    setSize('Working out the size…');
    const timer = setTimeout(async () => {
      try {
        const bytes = await encodeDocument(app.doc, format, quality / 100);
        if (!cancelled) setSize(`About ${formatBytes(bytes.length)}`);
      } catch {
        if (!cancelled) setSize('');
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [format, quality]);

  const confirm = () => props.resolve({ format, quality: quality / 100 });
  const writable = (Object.keys(FORMATS) as FileFormat[]).filter((f) => FORMATS[f].writable);

  return (
    <Dialog title="Save As" onCancel={() => props.resolve(null)} onConfirm={confirm}>
      <label class="field">
        <span>Format</span>
        <select value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as FileFormat)} data-autofocus>
          {writable.map((f) => (
            <option value={f} key={f}>
              {FORMATS[f].label}
            </option>
          ))}
        </select>
      </label>
      {lossy && (
        <label class="field">
          <span>Quality {quality}</span>
          <input type="range" min={10} max={100} value={quality} onInput={(e) => setQuality(Number((e.target as HTMLInputElement).value))} />
        </label>
      )}
      {format !== 'sktch' && app.doc.layers.length > 1 && <p class="hint">Layers will be merged into one picture.</p>}
      {(format === 'jpeg' || format === 'bmp') && <p class="hint">This format has no transparency, so see-through areas become white.</p>}
      <p class="hint">{size}</p>
      <div class="actions">
        <button type="button" onClick={() => props.resolve(null)}>
          Cancel
        </button>
        <button type="button" class="primary" onClick={confirm}>
          Save…
        </button>
      </div>
    </Dialog>
  );
}

/** A whole number from 1 to the largest picture size, or null. */
function sizeOf(text: string): number | null {
  const n = Math.round(Number(text));
  return text.trim() && Number.isFinite(n) && n >= 1 && n <= MAX_SIZE ? n : null;
}

function NumberField(props: { label: string; value: string; unit: string; onInput: (v: string) => void; autofocus?: boolean }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <span class="num-row">
        <input
          type="text"
          inputMode="numeric"
          class="num-field"
          value={props.value}
          data-autofocus={props.autofocus || undefined}
          onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
        />
        <span class="unit">{props.unit}</span>
      </span>
    </label>
  );
}

function ResizeDialog(props: { resolve: (v: { width: number; height: number; pixelArt: boolean } | null) => void }) {
  const W = app.doc.width;
  const H = app.doc.height;
  const [percent, setPercent] = useState(false);
  const [keep, setKeep] = useState(true);
  const [pixelArt, setPixelArt] = useState(false);
  const [w, setW] = useState(String(W));
  const [h, setH] = useState(String(H));

  // Both boxes hold pixels or percent; the result is always pixels.
  const toPixels = (text: string, full: number) => {
    const n = Number(text);
    if (!text.trim() || !Number.isFinite(n) || n <= 0) return null;
    return sizeOf(String(percent ? Math.round((full * n) / 100) : n));
  };
  const width = toPixels(w, W);
  const height = toPixels(h, H);
  const setUnits = (pct: boolean) => {
    if (pct === percent) return;
    const cw = width ?? W;
    const ch = height ?? H;
    setW(String(pct ? Math.round((cw / W) * 1000) / 10 : cw));
    setH(String(pct ? Math.round((ch / H) * 1000) / 10 : ch));
    setPercent(pct);
  };
  const editW = (v: string) => {
    setW(v);
    const n = Number(v);
    if (keep && v.trim() && Number.isFinite(n)) setH(String(percent ? n : Math.max(1, Math.round((n * H) / W))));
  };
  const editH = (v: string) => {
    setH(v);
    const n = Number(v);
    if (keep && v.trim() && Number.isFinite(n)) setW(String(percent ? n : Math.max(1, Math.round((n * W) / H))));
  };
  const ok = width !== null && height !== null;
  const confirm = () => ok && props.resolve({ width, height, pixelArt });

  return (
    <Dialog title="Resize" onCancel={() => props.resolve(null)} onConfirm={confirm}>
      <div class="field">
        <span>By</span>
        <div class="segmented">
          <button type="button" class={percent ? '' : 'on'} onClick={() => setUnits(false)}>
            Pixels
          </button>
          <button type="button" class={percent ? 'on' : ''} onClick={() => setUnits(true)}>
            Percent
          </button>
        </div>
      </div>
      <NumberField label="Width" value={w} unit={percent ? '%' : 'px'} onInput={editW} autofocus />
      <NumberField label="Height" value={h} unit={percent ? '%' : 'px'} onInput={editH} />
      <label class="check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep((e.target as HTMLInputElement).checked)} />
        Keep proportions
      </label>
      <label class="check">
        <input type="checkbox" checked={pixelArt} onChange={(e) => setPixelArt((e.target as HTMLInputElement).checked)} />
        Pixel art (keep hard edges)
      </label>
      <p class="hint">{ok ? `${W} × ${H} becomes ${width} × ${height} pixels.` : `Sizes go from 1 to ${MAX_SIZE} pixels.`}</p>
      <div class="actions">
        <button type="button" onClick={() => props.resolve(null)}>
          Cancel
        </button>
        <button type="button" class="primary" disabled={!ok} onClick={confirm}>
          Resize
        </button>
      </div>
    </Dialog>
  );
}

const ANCHORS = [0, 0.5, 1];

function CanvasSizeDialog(props: { resolve: (v: { width: number; height: number; ax: number; ay: number } | null) => void }) {
  const [w, setW] = useState(String(app.doc.width));
  const [h, setH] = useState(String(app.doc.height));
  const [anchor, setAnchor] = useState({ ax: 0.5, ay: 0.5 });
  const width = sizeOf(w);
  const height = sizeOf(h);
  const ok = width !== null && height !== null;
  const confirm = () => ok && props.resolve({ width, height, ...anchor });
  return (
    <Dialog title="Canvas Size" onCancel={() => props.resolve(null)} onConfirm={confirm}>
      <NumberField label="Width" value={w} unit="px" onInput={setW} autofocus />
      <NumberField label="Height" value={h} unit="px" onInput={setH} />
      <div class="field">
        <span>Picture sits</span>
        <div class="anchor-grid" role="radiogroup" aria-label="Where the picture sits">
          {ANCHORS.map((ay) =>
            ANCHORS.map((ax) => (
              <button
                type="button"
                role="radio"
                key={`${ax},${ay}`}
                aria-checked={anchor.ax === ax && anchor.ay === ay}
                class={anchor.ax === ax && anchor.ay === ay ? 'on' : ''}
                onClick={() => setAnchor({ ax, ay })}
              />
            )),
          )}
        </div>
      </div>
      <p class="hint">{app.doc.fill ? 'New space on the bottom layer is filled white.' : 'New space is see-through.'}</p>
      <div class="actions">
        <button type="button" onClick={() => props.resolve(null)}>
          Cancel
        </button>
        <button type="button" class="primary" disabled={!ok} onClick={confirm}>
          OK
        </button>
      </div>
    </Dialog>
  );
}

function Slider(props: { label: string; min: number; max: number; value: number; unit?: string; onInput: (v: number) => void; autofocus?: boolean }) {
  return (
    <label class="field adjust-field">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        data-autofocus={props.autofocus || undefined}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
        onDblClick={() => props.onInput(0)}
      />
      <span class="num-out">
        {props.value > 0 ? '+' : ''}
        {props.value}
        {props.unit ?? ''}
      </span>
    </label>
  );
}

/**
 * Brightness and contrast, or hue and saturation. It sits at the side without darkening the picture,
 * which shows the change as the sliders move. Double-click a slider to put it back to 0.
 */
function AdjustDialog(props: { adjust: 'brightness' | 'hue'; preview: (a: Adjustment | null) => void; resolve: (v: Adjustment | null) => void }) {
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const value = (x: number, y: number): Adjustment =>
    props.adjust === 'brightness' ? { kind: 'brightness', brightness: x, contrast: y } : { kind: 'hue', hue: x, saturation: y };
  useEffect(() => props.preview(value(a, b)), [a, b]);
  const confirm = () => props.resolve(value(a, b));
  const bright = props.adjust === 'brightness';
  return (
    <Dialog title={bright ? 'Brightness and Contrast' : 'Hue and Saturation'} side onCancel={() => props.resolve(null)} onConfirm={confirm}>
      {bright ? (
        <>
          <Slider label="Brightness" min={-100} max={100} value={a} onInput={setA} autofocus />
          <Slider label="Contrast" min={-100} max={100} value={b} onInput={setB} />
        </>
      ) : (
        <>
          <Slider label="Hue" min={-180} max={180} value={a} unit="°" onInput={setA} autofocus />
          <Slider label="Saturation" min={-100} max={100} value={b} onInput={setB} />
        </>
      )}
      <p class="hint">{app.selection ? 'Changes the selection.' : `Changes ${app.doc.activeLayer.name}.`}</p>
      <div class="actions">
        <button
          type="button"
          onClick={() => {
            setA(0);
            setB(0);
          }}
        >
          Reset
        </button>
        <button type="button" onClick={() => props.resolve(null)}>
          Cancel
        </button>
        <button type="button" class="primary" onClick={confirm}>
          OK
        </button>
      </div>
    </Dialog>
  );
}

export function Modals() {
  const m = app.modal;
  if (!m) return null;
  switch (m.kind) {
    case 'unsaved':
      return (
        <Dialog title="Save your changes?" onCancel={() => m.resolve('cancel')}>
          <p>{`${app.file.name} has changes that haven't been saved.`}</p>
          {/* Clicking outside the box or Esc cancels. */}
          <div class="actions">
            <button type="button" onClick={() => m.resolve('discard')}>
              Don't Save
            </button>
            <button type="button" class="primary" onClick={() => m.resolve('save')} data-autofocus>
              Save
            </button>
          </div>
        </Dialog>
      );
    case 'keep-layers': {
      // One layer with shapes or text: they're what a flat picture would lose.
      const oneLayer = app.doc.layers.length === 1;
      const format = FORMATS[app.file.format ?? 'png'].label;
      return (
        <Dialog title={app.doc.board ? 'Keep your whiteboard?' : oneLayer ? 'Keep your shapes and text?' : 'Keep your layers?'} onCancel={() => m.resolve('cancel')}>
          <p>
            {app.doc.board
              ? `${format} files can't hold a whiteboard. Save a Sketch file to keep it endless and editable, or save a picture of what's on it.`
              : oneLayer
                ? `${format} files can't keep shapes and text editable. Save a Sketch file to keep them, or merge them into the picture.`
                : `${format} files can't hold layers. Save a Sketch file to keep them, or merge them into one picture.`}
          </p>
          <div class="actions">
            <button type="button" onClick={() => m.resolve('cancel')}>
              Cancel
            </button>
            <button type="button" onClick={() => m.resolve('flatten')}>
              {app.doc.board ? 'Save Picture' : 'Merge and Save'}
            </button>
            <button type="button" class="primary" onClick={() => m.resolve('sktch')} data-autofocus>
              Save as .sktch
            </button>
          </div>
        </Dialog>
      );
    }
    case 'save-as':
      return <SaveAsDialog initial={m.initial} resolve={m.resolve} />;
    case 'resize':
      return <ResizeDialog resolve={m.resolve} />;
    case 'canvas-size':
      return <CanvasSizeDialog resolve={m.resolve} />;
    case 'adjust':
      return <AdjustDialog adjust={m.adjust} preview={m.preview} resolve={m.resolve} />;
    case 'about':
      return <AboutDialog resolve={m.resolve} />;
    case 'cutout-download':
      return <CutoutDownloadDialog resolve={m.resolve} />;
  }
}

function AboutDialog(props: { resolve: (v: null) => void }) {
  const b = __SKETCH_BUILD__;
  const built = b.builtAt ? new Date(b.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return (
    <Dialog title="About Sketch" onCancel={() => props.resolve(null)} onConfirm={() => props.resolve(null)}>
      <p>A fast, simple paint app for Windows.</p>
      <p>Version {b.version}</p>
      <p class="hint about-build">
        {b.commit ? `Build ${b.commit.slice(0, 7)}${built ? `, ${built}` : ''}` : 'Development build'}
        {b.subject && (
          <>
            <br />
            {b.subject}
          </>
        )}
      </p>
      <div class="actions">
        <button type="button" class="primary" onClick={() => props.resolve(null)} data-autofocus>
          OK
        </button>
      </div>
    </Dialog>
  );
}

/** Remove Background's first use: offers the add-on, then shows its download. Resolves true once it's there. */
function CutoutDownloadDialog(props: { resolve: (v: boolean) => void }) {
  const [state, setState] = useState<{ step: 'ask' } | { step: 'loading'; share: number } | { step: 'failed'; error: string }>({ step: 'ask' });
  const start = () => {
    setState({ step: 'loading', share: 0 });
    platform
      .installCutout((share) => setState({ step: 'loading', share }))
      .then(() => props.resolve(true))
      .catch((e) => (String(e) === 'cancelled' ? props.resolve(false) : setState({ step: 'failed', error: String(e) })));
  };
  // While downloading, cancelling stops the download, which then resolves false.
  const cancel = () => (state.step === 'loading' ? void platform.cancelCutoutDownload() : props.resolve(false));
  return (
    <Dialog title="Download Remove Background?" onCancel={cancel} onConfirm={state.step === 'loading' ? undefined : start}>
      <p>Remove Background cuts out the person or object in front using a model that runs on this PC, so your pictures never leave it.</p>
      {state.step === 'ask' && <p class="hint">It's a one-time download of {platform.CUTOUT_DOWNLOAD_MB} MB.</p>}
      {state.step === 'loading' && (
        <>
          <progress class="download" max={1} value={state.share} aria-label="Download progress" />
          <p class="hint">
            {Math.round(state.share * platform.CUTOUT_DOWNLOAD_MB)} of {platform.CUTOUT_DOWNLOAD_MB} MB
          </p>
        </>
      )}
      {state.step === 'failed' && <p class="hint">The download didn't finish: {state.error}.</p>}
      <div class="actions">
        <button type="button" onClick={cancel}>
          Cancel
        </button>
        {state.step !== 'loading' && (
          <button type="button" class="primary" onClick={start} data-autofocus>
            {state.step === 'failed' ? 'Try Again' : 'Download'}
          </button>
        )}
      </div>
    </Dialog>
  );
}
