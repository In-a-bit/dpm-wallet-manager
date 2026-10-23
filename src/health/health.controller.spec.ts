import type { Response } from "express";

import type { Db } from "../db/client";
import { HealthController } from "./health.controller";

function fakeRes(): { res: Response; status: jest.Mock } {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

describe("HealthController readiness", () => {
  it("answers ok after SELECT 1", async () => {
    const query = jest.fn().mockResolvedValue([{ "?column?": 1 }]);
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db).ready(res);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(body).toEqual({ status: "ok" });
    expect(status).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable when the query throws", async () => {
    const query = jest.fn().mockRejectedValue(new Error("connection refused"));
    const { res, status } = fakeRes();
    const body = await new HealthController({ query } as unknown as Db).ready(res);
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: "unavailable" });
  });

  it("answers 503 when the query hangs past the timeout", async () => {
    jest.useFakeTimers();
    try {
      const query = jest.fn().mockReturnValue(new Promise(() => undefined));
      const { res, status } = fakeRes();
      const pending = new HealthController({ query } as unknown as Db).ready(res);
      await jest.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ status: "unavailable" });
      expect(status).toHaveBeenCalledWith(503);
    } finally {
      jest.useRealTimers();
    }
  });
});
