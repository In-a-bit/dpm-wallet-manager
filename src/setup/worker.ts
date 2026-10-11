import type { Journal } from "./journal";
import { isComplete, provision, type ProvisioningDeps } from "./steps";

const TICK_MS = 1_000;

/**
 * The setup container's main process. It runs provisioning, so a closed terminal or a dropped SSH
 * connection never stops a setup half-way: the terminal only records answers and watches. It
 * starts a run when answers appear, when a retry is asked for, and once after any restart.
 */
export class SetupWorker {
  private active?: Promise<void>;
  private retryOnStart = true;

  constructor(
    private readonly deps: ProvisioningDeps,
    private readonly journal?: Journal,
  ) {}

  start(): void {
    // Nothing else runs provisioning, so a `running` left by a killed process is stale.
    this.deps.store.update((state) => {
      state.running = false;
    });
    setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  /** One look at the state; starts a run when there is work and nothing stops it. */
  async tick(): Promise<void> {
    if (this.active) return;
    const state = this.deps.store.load();
    if (!state.answers || isComplete(state)) return;
    const retry = this.deps.store.retryRequested() || this.retryOnStart;
    this.retryOnStart = false;
    if (state.lastError && !retry) return;
    if (state.lastError) this.journal?.append({ type: "note", message: "Retrying" });
    // provision() marks the state running before its first await; only then is the request
    // cleared, so a watcher never sees the old failure with no request pending.
    this.active = provision(this.deps).then(
      () => undefined,
      () => undefined, // Recorded in the state and the journal; the terminal shows it.
    );
    this.deps.store.clearRetryRequest();
    await this.active;
    this.active = undefined;
  }
}
