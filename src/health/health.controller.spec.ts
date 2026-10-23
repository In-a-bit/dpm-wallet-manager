import type { Request, Response } from "express";

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

/** A request from `remoteAddress`; the default is the CLI's in-container call on loopback. */
function fakeReq(...args: [remoteAddress?: string]): Request {
  const remoteAddress = args.length === 0 ? "127.0.0.1" : args[0];
  return { socket: { remoteAddress } } as unknown as Request;
}

describe("HealthController readiness", () => {
  it("answers ok after SELECT 1", async () => {
    const query = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db, samples()).ready(
      fakeReq(),
      res,
    );
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(body).toEqual({ status: "ok" });
    expect(status).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable when the query throws", async () => {
    const query = jest.fn().mockRejectedValue(new Error("connection refused"));
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db, samples()).ready(
      fakeReq(),
      res,
    );
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: "unavailable" });
  });

  it("answers 503 when the query hangs past the timeout", async () => {
    jest.useFakeTimers();
    try {
      const query = jest.fn().mockReturnValue(new Promise(() => undefined));
      const { res, status } = fakeRes();
      const pending = new HealthController({ query } as unknown as Db, samples()).ready(
        fakeReq(),
        res,
      );
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
    const body = await new HealthController({ query } as unknown as Db, samples(latest)).ready(
      fakeReq(),
      res,
    );
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
    const body = await new HealthController({ query } as unknown as Db, samples(latest)).ready(
      fakeReq(),
      res,
    );
    expect(body).toEqual({ status: "ok" });
    expect(status).not.toHaveBeenCalled();
  });

  describe("storage field is for loopback callers only", () => {
    const query = jest.fn().mockResolvedValue([]);
    const latest = async () => ({ level: "critical", diskUsedPercent: 96, daysToFull: 3 });

    it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("includes it for %s", async (addr) => {
      const { res } = fakeRes();
      const body = await new HealthController({ query } as unknown as Db, samples(latest)).ready(
        fakeReq(addr),
        res,
      );
      expect(body).toEqual({
        status: "ok",
        storage: { level: "critical", usedPercent: 96, daysToFull: 3 },
      });
    });

    it.each(["10.0.0.7", "172.18.0.1", "::ffff:192.168.1.5", "2001:db8::1", undefined])(
      "omits it for %s, and stays 200",
      async (addr) => {
        const read = jest.fn(latest);
        const { res, status } = fakeRes();
        const body = await new HealthController({ query } as unknown as Db, samples(read)).ready(
          fakeReq(addr),
          res,
        );
        expect(body).toEqual({ status: "ok" });
        expect(read).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
      },
    );
  });
});
