import type { CliPresets } from "../cli";
import type { Journal } from "../journal";
import type { SetupService } from "../setup-service";

/**
 * What the CommonJS entry hands the dashboard. Kept apart from the dashboard itself so that
 * importing the type never pulls Ink (ESM with top-level await) into the CommonJS build.
 */
export type DashboardOptions = {
  service: SetupService;
  journal: Journal;
  presets: CliPresets;
  /** How long the installer took to download and start the services, when it said. */
  installSeconds?: number;
  /** Where the builder reaches the wallet manager from outside the stack. */
  managerPublicUrl: string;
};

export type DashboardModule = { runDashboard: (options: DashboardOptions) => Promise<void> };
