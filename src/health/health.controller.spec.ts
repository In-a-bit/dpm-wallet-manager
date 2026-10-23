import type { Response } from "express";

import type { Db } from "../db/client";
import type { StorageSampleRepository } from "../db/repositories/storage-sample.repo";
import { HealthController } from "./health.controller";

function samples(latest: () => Promise<unknown> = async () => undefined): StorageSampleRepository {
  return { latest } as unknown as StorageSampleRepository;
}

function fakeRes(): { res: Response; status: jest.Mock } {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

describe("HealthController readiness", () => {
  it("answers ok after SELECT 1", async () => {
    const query = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db, samples()).ready(res);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(body).toEqual({ status: "ok" });
    expect(status).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable when the query throws", async () => {
    const query = jest.fn().mockRejectedValue(new Error("connection refused"));
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db, samples()).ready(res);
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: "unavailable" });
  });

  it("answers 503 when the query hangs past the timeout", async () => {
    jest.useFakeTimers();
    try {
      const query = jest.fn().mockReturnValue(new Promise(() => undefined));
      const { res, status } = fakeRes();
      const pending = new HealthController({ query } as unknown as Db, samples()).ready(res);
      await jest.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ status: "unavailable" });
      expect(status).toHaveBeenCalledWith(503);
    } finally {
      jest.useRealTimers();
    }
  });

  it("adds the storage field from the latest sample", async () => {
    const query = jest.fn().mockResolvedValue([]);
    const latest = async () => ({ level: "warning", diskUsedPercent: 81.234, daysToFull: 12.6 });
    const { res } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db, samples(latest)).ready(res);
    expect(body).toEqual({
      status: "ok",
      storage: { level: "warning", usedPercent: 81.2, daysToFull: 13 },
    });
  });

  it("omits storage when the read fails, and stays 200", async () => {
    const query = jest.fn().mockResolvedValue([]);
    const latest = async () => {
      throw new Error("relation missing");
    };
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db, samples(latest)).ready(res);
    expect(body).toEqual({ status: "ok" });
    expect(status).not.toHaveBeenCalled();
  });
});
