import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { reminderDefault, RetentionSettingsService } from "./retention-settings.service";
import {
  RetentionSettingsDto,
  StorageSettingsDto,
  UpdateRetentionSettingsDto,
  UpdateStorageSettingsDto,
} from "./dto/settings.dto";
import { CONFIG } from "../tokens";
import type { Config } from "../config";
import {
  maskWebhookUrl,
  StorageSettingsService,
  type EffectiveStorage,
} from "./storage-settings.service";

/** Read-only values shown beside the editable retention settings. */
const FIXED = { idempotencyHours: 24, logs: "5 × 20 MB per service" } as const;

/**
 * Dashboard-editable settings. Any authenticated key may read them; changing them is admin only
 * (an owner signed in to the UI, or an admin key).
 */
@ApiTags("settings")
@ApiAuth()
@Controller("settings")
export class SettingsController {
  constructor(
    private readonly retention: RetentionSettingsService,
    private readonly storage: StorageSettingsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private defaults() {
    const env = this.config.retentionDefaults;
    return { ...env, archiveReminderDays: reminderDefault(env.routineDays) };
  }

  /** Admins see the webhook as stored; everyone else sees it masked. */
  private storageView(effective: EffectiveStorage, actor: Actor): StorageSettingsDto {
    const full = actor.role === "admin";
    return {
      ...effective,
      alertWebhookUrl: full ? effective.alertWebhookUrl : maskWebhookUrl(effective.alertWebhookUrl),
      alertWebhookConfigured: effective.alertWebhookUrl !== null,
    };
  }

  /**
   * Read the retention settings.
   *
   * The values in force, where each comes from (`default`, `environment` or `dashboard`), and the
   * fixed values that cannot be changed.
   */
  @Get("retention")
  @ApiOperation({ operationId: "getRetentionSettings", summary: "Read the retention settings" })
  @ApiOkResponse({ type: RetentionSettingsDto })
  async getRetention(): Promise<RetentionSettingsDto> {
    return {
      ...(await this.retention.effective()),
      defaults: this.defaults(),
      fixed: { ...FIXED },
    };
  }

  /**
   * Change the retention settings.
   *
   * Send only the keys to change; `null` reverts a key to its environment default. The bounds are
   * checked against the values that would be in force afterwards, and a violation changes
   * nothing. Takes effect on the next retention run, with no restart.
   */
  @Put("retention")
  @Roles("admin")
  @ApiOperation({
    operationId: "updateRetentionSettings",
    summary: "Change the retention settings",
  })
  @ApiOkResponse({ type: RetentionSettingsDto })
  @ApiErrors("VALIDATION_FAILED", "CSRF_HEADER_REQUIRED")
  async updateRetention(
    @Body() body: UpdateRetentionSettingsDto,
    @CurrentActor() actor: Actor,
  ): Promise<RetentionSettingsDto> {
    return {
      ...(await this.retention.update(body, actor)),
      defaults: this.defaults(),
      fixed: { ...FIXED },
    };
  }

  /**
   * Read the storage settings.
   *
   * The warning and critical thresholds for disk usage and days of disk left, and the alert
   * webhook, each with where it comes from. Only admins see the full webhook URL; other roles
   * get it masked to its origin.
   */
  @Get("storage")
  @ApiOperation({ operationId: "getStorageSettings", summary: "Read the storage settings" })
  @ApiOkResponse({ type: StorageSettingsDto })
  async getStorage(@CurrentActor() actor: Actor): Promise<StorageSettingsDto> {
    return this.storageView(await this.storage.effective(), actor);
  }

  /**
   * Change the storage settings.
   *
   * Send only the keys to change; `null` reverts a key to its default. Percents are 1 to 99 with
   * warning below critical; days are 1 to 365 with warning above critical; the webhook is an http
   * or https URL. A violation changes nothing.
   */
  @Put("storage")
  @Roles("admin")
  @ApiOperation({ operationId: "updateStorageSettings", summary: "Change the storage settings" })
  @ApiOkResponse({ type: StorageSettingsDto })
  @ApiErrors("VALIDATION_FAILED", "CSRF_HEADER_REQUIRED")
  async updateStorage(
    @Body() body: UpdateStorageSettingsDto,
    @CurrentActor() actor: Actor,
  ): Promise<StorageSettingsDto> {
    return this.storageView(await this.storage.update(body, actor), actor);
  }
}
