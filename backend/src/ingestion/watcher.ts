import fs from "node:fs";

/**
 * Watches project folders (FSEvents on macOS via fs.watch recursive) and calls `onChange` after a
 * quiet period, so a burst of saves results in one incremental rescan.
 */
export class FolderWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly onChange: (projectId: string) => void,
    private readonly debounceMs = 5_000,
  ) {}

  watch(projectId: string, folder: string): boolean {
    this.unwatch(projectId);
    try {
      const watcher = fs.watch(folder, { recursive: true, persistent: false }, (_event, filename) => {
        const name = filename?.toString() ?? "";
        // Ignore churn in folders that are always excluded.
        if (/(^|[\\/])(\.git|node_modules|\.venv|__pycache__|dist|build)([\\/]|$)/.test(name)) return;
        this.schedule(projectId);
      });
      watcher.on("error", () => this.unwatch(projectId));
      this.watchers.set(projectId, watcher);
      return true;
    } catch {
      return false; // folder missing or watching unsupported; the scheduler still rescans periodically
    }
  }

  private schedule(projectId: string): void {
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(projectId);
      this.onChange(projectId);
    }, this.debounceMs);
    t.unref();
    this.timers.set(projectId, t);
  }

  unwatch(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    const t = this.timers.get(projectId);
    if (t) clearTimeout(t);
    this.timers.delete(projectId);
  }

  closeAll(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}
