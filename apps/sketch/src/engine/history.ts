/** One undoable change. Commands are recorded after they have been applied. */
export interface Command {
  readonly label: string;
  /** Rough memory the command holds, used for the history's memory cap. */
  readonly bytes: number;
  apply(): void;
  revert(): void;
  /**
   * Set on a step made only to get ready for the next one (a whiteboard growing before a stroke):
   * the next step recorded takes it in, so one undo takes both away.
   */
  readonly joinNext?: boolean;
}

export interface HistoryEntry {
  label: string;
  /** The history position this entry leads to; null when it can't be jumped to. */
  position: number | null;
  current: boolean;
  undone: boolean;
}

export const DEFAULT_HISTORY_CAP = 1024 ** 3;

export class History {
  private done: Command[] = [];
  private undone: Command[] = [];
  /** Steps dropped from the start to stay under the memory cap. */
  private evicted = 0;
  private used = 0;
  private savedAt = 0;
  /** Goes up on every change, so autosave can tell whether anything happened since it last ran. */
  revision = 0;
  baseLabel = 'New picture';
  onChange: () => void = () => {};

  constructor(public cap = DEFAULT_HISTORY_CAP) {}

  /** Number of steps applied since the history began, counting dropped ones. */
  get position(): number {
    return this.evicted + this.done.length;
  }
  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }
  get dirty(): boolean {
    return this.savedAt !== this.position;
  }
  get bytesUsed(): number {
    return this.used;
  }
  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }
  /** The last step done, for joining a run of small changes into it. */
  get top(): Command | undefined {
    return this.done.at(-1);
  }

  record(cmd: Command): void {
    const top = this.done.at(-1);
    if (top?.joinNext && this.undone.length === 0) {
      this.done.pop();
      this.used -= top.bytes;
      // The state saved after the first part only is gone once they're one step.
      if (this.savedAt === this.position + 1) this.savedAt = -1;
      cmd = new CompositeCommand(cmd.label, [top, cmd]);
    }
    for (const c of this.undone) this.used -= c.bytes;
    // The saved state was in the redo steps being thrown away, so it can't be reached again.
    if (this.savedAt > this.position) this.savedAt = -1;
    this.undone = [];
    this.done.push(cmd);
    this.used += cmd.bytes;
    this.trim();
    this.changed();
  }

  undo(): boolean {
    const ok = this.step(-1);
    if (ok) this.changed();
    return ok;
  }

  redo(): boolean {
    const ok = this.step(1);
    if (ok) this.changed();
    return ok;
  }

  /** Undoes the last step and forgets it, with nothing to redo (a growth whose stroke never came). */
  discardTop(): void {
    const c = this.done.pop();
    if (!c) return;
    if (this.savedAt === this.position + 1) this.savedAt = -1;
    c.revert();
    this.used -= c.bytes;
    this.changed();
  }

  jumpTo(position: number): void {
    let moved = false;
    while (position < this.position && this.step(-1)) moved = true;
    while (position > this.position && this.step(1)) moved = true;
    if (moved) this.changed();
  }

  markSaved(): void {
    this.savedAt = this.position;
    this.changed();
  }

  /** Marks the picture as having unsaved changes with no step to undo (a picture brought back by autosave). */
  markUnsaved(): void {
    this.savedAt = -1;
    this.changed();
  }

  reset(baseLabel: string): void {
    this.done = [];
    this.undone = [];
    this.evicted = 0;
    this.used = 0;
    this.savedAt = 0;
    this.baseLabel = baseLabel;
    this.changed();
  }

  private changed(): void {
    this.revision++;
    this.onChange();
  }

  entries(): HistoryEntry[] {
    const pos = this.position;
    const list: HistoryEntry[] = [
      this.evicted > 0
        ? { label: `${this.evicted} earlier steps (cleared to save memory)`, position: null, current: false, undone: false }
        : { label: this.baseLabel, position: 0, current: pos === 0, undone: false },
    ];
    this.done.forEach((c, i) => {
      const p = this.evicted + i + 1;
      list.push({ label: c.label, position: p, current: p === pos, undone: false });
    });
    for (let i = this.undone.length - 1, p = pos + 1; i >= 0; i--, p++) {
      list.push({ label: this.undone[i].label, position: p, current: false, undone: true });
    }
    return list;
  }

  private step(dir: 1 | -1): boolean {
    if (dir < 0) {
      const c = this.done.pop();
      if (!c) return false;
      c.revert();
      this.undone.push(c);
    } else {
      const c = this.undone.pop();
      if (!c) return false;
      c.apply();
      this.done.push(c);
    }
    return true;
  }

  private trim(): void {
    while (this.used > this.cap && this.done.length > 1) {
      const c = this.done.shift()!;
      this.used -= c.bytes;
      this.evicted++;
    }
  }
}

/** Several commands undone and redone as one step. */
export class CompositeCommand implements Command {
  readonly bytes: number;
  constructor(
    readonly label: string,
    private readonly parts: Command[],
  ) {
    this.bytes = parts.reduce((n, c) => n + c.bytes, 0);
  }
  apply(): void {
    for (const c of this.parts) c.apply();
  }
  revert(): void {
    for (let i = this.parts.length - 1; i >= 0; i--) this.parts[i].revert();
  }
}
