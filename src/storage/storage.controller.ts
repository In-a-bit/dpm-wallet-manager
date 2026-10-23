import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { StorageStatusDto } from "./dto/storage.dto";
import { StorageMonitorService } from "./storage-monitor.service";

@ApiTags("storage")
@ApiAuth()
@Controller("storage")
export class StorageController {
  constructor(private readonly monitor: StorageMonitorService) {}

  /**
   * How full the install is.
   *
   * The latest 15-minute sample (disk, database and table sizes), growth per day, days to full and
   * the level, whether routine retention is shortened because of it, and the oldest important
   * record. Readable by every role.
   */
  @Get()
  @ApiOperation({ operationId: "getStorage", summary: "Get disk and database usage" })
  @ApiOkResponse({ type: StorageStatusDto })
  status(): Promise<StorageStatusDto> {
    return this.monitor.view();
  }
}
