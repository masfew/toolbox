import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ALargeSmall,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  Brush,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleArrowUp,
  Copy,
  Crop,
  Droplets,
  Eraser,
  Eye,
  EyeOff,
  Flashlight,
  Grid2x2,
  Hash,
  Hexagon,
  Highlighter,
  Keyboard,
  Lasso,
  Layers,
  LayersPlus,
  Lock,
  LockOpen,
  Maximize,
  MessageSquare,
  LoaderCircle,
  Minus,
  MousePointer2,
  MoveUpRight,
  PaintBucket,
  PanelRight,
  Pencil,
  Pentagon,
  Pipette,
  Plus,
  Redo2,
  Scaling,
  Search,
  Settings,
  SlidersHorizontal,
  Shapes,
  Square,
  SquareDashed,
  Star,
  SunDim,
  Trash,
  Type,
  Undo2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-preact';
import type { ComponentChildren, ComponentType } from 'preact';

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; class?: string }>;

/** Drawn like the Lucide ones (round ends, a 16 px grid) for the drag labels Lucide has no picture for: outline weight, corner radius, opacity. */
function drawn(draw: ComponentChildren): IconComponent {
  return ({ size = 16, class: cls }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class={cls} aria-hidden="true">
      {draw}
    </svg>
  );
}

const Outline = drawn(
  <>
    <path d="M2 3.5h12" stroke-width="1" />
    <path d="M2 8h12" stroke-width="2" />
    <path d="M2 12.5h12" stroke-width="3.2" stroke-linecap="butt" />
  </>,
);
const Corners = drawn(<path d="M3 13V8a5 5 0 0 1 5-5h5" />);
const Opacity = drawn(
  <>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
  </>,
);

const ICONS: Record<string, IconComponent> = {
  'select-rect': SquareDashed,
  'select-free': Lasso,
  'magic-wand': WandSparkles,
  crop: Crop,
  pencil: Pencil,
  brush: Brush,
  eraser: Eraser,
  fill: PaintBucket,
  picker: Pipette,
  text: Type,
  rectangle: Square,
  ellipse: Circle,
  polygon: Pentagon,
  star: Star,
  arrow: MoveUpRight,
  line: Minus,
  highlighter: Highlighter,
  blur: Droplets,
  pixelate: Grid2x2,
  marker: Hash,
  callout: MessageSquare,
  spotlight: Flashlight,
  undo: Undo2,
  redo: Redo2,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  fit: Maximize,
  panel: PanelRight,
  layers: Layers,
  'layer-new': LayersPlus,
  'merge-down': ArrowDownToLine,
  eye: Eye,
  'eye-off': EyeOff,
  lock: Lock,
  'lock-open': LockOpen,
  plus: Plus,
  trash: Trash,
  shapes: Shapes,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  search: Search,
  keyboard: Keyboard,
  settings: Settings,
  swap: ArrowLeftRight,
  check: Check,
  close: X,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'align-left': AlignStartVertical,
  'align-hcentre': AlignCenterVertical,
  'align-right': AlignEndVertical,
  'align-top': AlignStartHorizontal,
  'align-vcentre': AlignCenterHorizontal,
  'align-bottom': AlignEndHorizontal,
  'distribute-x': AlignHorizontalDistributeCenter,
  'distribute-y': AlignVerticalDistributeCenter,
  outline: Outline,
  corners: Corners,
  opacity: Opacity,
  sides: Hexagon,
  points: Star,
  'text-size': ALargeSmall,
  size: Scaling,
  number: Hash,
  tolerance: SlidersHorizontal,
  strength: Droplets,
  block: Grid2x2,
  dim: SunDim,
  mouse: MousePointer2,
  capture: Camera,
  copy: Copy,
  'update-ready': CircleArrowUp,
  'update-building': LoaderCircle,
};

export function Icon(props: { name: string; size?: number; class?: string }) {
  const C = ICONS[props.name];
  return C ? <C size={props.size ?? 18} strokeWidth={1.75} class={props.class} /> : null;
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}
