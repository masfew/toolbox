import { useEffect, useRef } from 'preact/hooks';
import * as actions from '../app/actions';
import { fitView } from '../app/board';
import { frameOf } from '../engine/board';
import { keysFor, runCommand } from '../app/commandList';
import { prettyCombo } from '../app/keys';
import { app, changed, cursorSignal, tabs, uiSignal } from '../app/store';
import { update } from '../app/update';
import { cropBox } from '../tools/crop';
import { pickedObjects } from '../tools/shapes';
import { currentTool } from '../app/tools';
import { CanvasController } from '../view/input';
import { Renderer } from '../view/renderer';
import * as platform from '../platform';
import { useSignal } from './hooks';
import { Icon } from './icons';
import { MenuBar } from './MenuBar';
import { Modals } from './Modals';
import { OptionsBar } from './OptionsBar';
import { Overlays } from './Overlays';
import { SidePanel } from './SidePanel';
import { TabStrip } from './TabStrip';
import { ToolRail } from './ToolRail';
import { TextEditor } from './TextEditor';
import { Tooltip } from './Tooltip';

function CanvasView() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const renderer = new Renderer(canvas);
    app.requestRender = () => renderer.request();
    new CanvasController(canvas, renderer);
    let fitted = false;
    // The observer fires once the canvas has its real size, so the first fit happens there.
    const ro = new ResizeObserver(() => {
      const v = app.viewport;
      const oldW = v.width;
      const oldH = v.height;
      if (!renderer.resize()) return;
      if (!fitted && v.width > 0 && v.height > 0) {
        fitted = true;
        fitView(1);
        renderer.onFirstFrame = () => void platform.appReady();
        changed();
      } else {
        // Keep the picture where it was relative to the centre.
        v.panX += (v.width - oldW) / 2;
        v.panY += (v.height - oldH) / 2;
        renderer.request();
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);
  return (
    <div class="view-wrap">
      <canvas class="view" ref={ref} />
      <TextEditor />
    </div>
  );
}

const keyText = (id: string) => keysFor(id).slice(0, 1).map(prettyCombo).join('');

function StatusBar() {
  useSignal(cursorSignal);
  const board = app.doc.board;
  // A whiteboard's pixel positions move as it grows, so they aren't shown. A capture's count from
  // its own corner, wherever its canvas has grown.
  const frame = frameOf(app.doc);
  const c = board || !app.cursor ? null : { x: app.cursor.x - frame.x, y: app.cursor.y - frame.y };
  const sel = app.selection;
  const r = app.resizePreview;
  const crop = currentTool().id === 'crop' ? cropBox() : null;
  const picked = pickedObjects()?.objects;
  const one = picked?.length === 1 ? picked[0] : null;
  const shapeSize = one && one.type !== 'line' ? `${Math.round(one.w)} × ${Math.round(one.h)} px` : '';
  const size = sel ? `${Math.round(sel.w)} × ${Math.round(sel.h)} px` : crop ? `${crop.w} × ${crop.h} px` : shapeSize;
  let message = '';
  if (app.textEdit) message = 'Typing. Click the picture or press Esc to finish. Drag the frame to move the text.';
  else if (one?.type === 'line') message = 'Drag the ends to move them (Shift for 15° steps) or the middle to bend it. Shift+click picks more. Delete removes it.';
  else if (one) message = 'Drag to move, handles to resize or turn (Shift keeps the shape). Shift+click picks more. Delete removes it, Ctrl+D copies it.';
  else if (picked) message = `${picked.length} shapes picked. Drag to move them, or line them up from the bar above. Hold Ctrl to move without snapping.`;
  else if (sel?.pasted) message = 'Pasted picture: drag to move it, handles to resize or turn it. Enter places it, Esc cancels.';
  else if (sel) message = 'Drag to move, handles to resize or turn (Shift keeps the shape). Enter places it, Esc cancels, Delete clears.';
  else if (crop) message = 'Drag the handles or draw a box round what to keep. Enter crops, Esc starts again.';
  return (
    <footer class="statusbar">
      <span class="st-cursor" data-tip="Pointer position">
        {c ? `${c.x}, ${c.y} px` : ''}
      </span>
      <span class="st-selection" data-tip={sel ? 'Selection size' : crop ? 'Crop size' : undefined}>
        {size}
      </span>
      <span class="st-message">{message}</span>
      <span class="st-version">
        {update.ready ? (
          // A new version is waiting for a restart (F11). Only something to look at: no click, no tooltip.
          <span class="st-update" role="img" aria-label="Update ready">
            <Icon name="update-ready" size={14} />
          </span>
        ) : (
          update.building && (
            // A newer version is building in the background; the ready icon takes its place when it's done.
            <span class="st-building" role="img" aria-label="Update building">
              <Icon name="update-building" size={14} />
            </span>
          )
        )}
        <span data-tip="Sketch version">v{__SKETCH_BUILD__.version}</span>
      </span>
      <span class="st-size" data-tip={board ? undefined : 'Picture size'}>
        {board ? 'Whiteboard' : r ? `New size ${r.w} × ${r.h} px` : `${frame.w} × ${frame.h} px`}
      </span>
      <span class="st-zoom">
        <button type="button" class="icon-btn small" aria-label="Zoom out" data-tip="Zoom out" data-keys={keyText('view.zoomOut')} onClick={() => runCommand('view.zoomOut')}>
          <Icon name="zoom-out" size={15} />
        </button>
        <button type="button" class="zoom-pct" data-tip="Actual size" data-keys={keyText('view.actual')} onClick={() => runCommand('view.actual')}>
          {Math.round(app.viewport.zoom * 100)}%
        </button>
        <button type="button" class="icon-btn small" aria-label="Zoom in" data-tip="Zoom in" data-keys={keyText('view.zoomIn')} onClick={() => runCommand('view.zoomIn')}>
          <Icon name="zoom-in" size={15} />
        </button>
        <button
          type="button"
          class="icon-btn small"
          aria-label={board ? 'Zoom to fit everything' : 'Fit to window'}
          data-tip={board ? 'Zoom to fit everything' : 'Fit to window'}
          data-keys={keyText('view.fit')}
          onClick={() => runCommand('view.fit')}
        >
          <Icon name="fit" size={15} />
        </button>
      </span>
    </footer>
  );
}

function Toast() {
  if (!app.toast) return null;
  return (
    <div class="toast" key={app.toast.id} role="status">
      {app.toast.text}
      {app.toast.action && (
        <button
          type="button"
          class="toast-action"
          onClick={() => {
            const run = app.toast?.action?.run;
            app.toast = null;
            run?.();
            changed();
          }}
        >
          {app.toast.action.label}
        </button>
      )}
    </div>
  );
}

export function App() {
  useSignal(uiSignal);
  useEffect(() => {
    actions.updateTitle();
  });
  return (
    <div class={tabs.list.length > 1 ? 'app tabbed' : 'app'}>
      <MenuBar />
      <TabStrip />
      <OptionsBar />
      <div class="main">
        <ToolRail />
        <CanvasView />
        {app.showPanel && <SidePanel />}
      </div>
      <StatusBar />
      <Toast />
      <Tooltip />
      <Overlays />
      <Modals />
    </div>
  );
}
