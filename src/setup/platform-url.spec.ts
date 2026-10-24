import {
  environmentForUrl,
  findEnvironment,
  isSafePlatformUrl,
  resolveDpmApiUrl,
} from "./environments";
import { fetchInstallConfig, type FetchLike } from "./platform-config";

const CONFIG = {
  owner: { name: "builder" },
  chain_id: 137,
  contracts: {
    ctf_exchange: "0x1111111111111111111111111111111111111111",
    proxy_factory: "0x2222222222222222222222222222222222222222",
    proxy_impl: "0x3333333333333333333333333333333333333333",
  },
  services: {
    dpm_api: "https://dpm-api.example",
    gamma_api: "https://gamma-api.example",
    relayer_api: "https://relayer-api.example",
  },
};

describe("isSafePlatformUrl", () => {
  it.each([
    "https://api.example.com",
    "http://localhost:8086",
    "http://127.0.0.1:8086",
    "http://[::1]:8086",
    "http://host.docker.internal:8086",
    "HTTP://localhost",
    "HTTP://LOCALHOST:8086/path",
  ])("accepts %s", (url) => expect(isSafePlatformUrl(url)).toBe(true));

  it.each([
    "http://api.example.com",
    "http://10.0.0.5:8086",
    "http://localhost.evil.example",
    "http://localhost@evil.com",
    "http://localhost:80@evil.com/",
    "http://127.0.0.1.nip.io",
    "http://[::ffff:127.0.0.1]",
    "ftp://localhost",
    "not a url",
  ])("refuses %s", (url) => expect(isSafePlatformUrl(url)).toBe(false));
});

describe("custom platform address", () => {
  const custom = findEnvironment("custom")!;

  // SETUP_PLATFORM_URL reaches setup as a platform answer: environmentForUrl, then the same check.
  it.each(["http://localhost@evil.com", "http://127.0.0.1.nip.io", "http://[::ffff:127.0.0.1]"])(
    "refuses %s given through the SETUP_PLATFORM_URL path",
    (preset) => {
      const { environment, customUrl } = environmentForUrl(preset);
      expect(environment).toBe("custom");
      expect(resolveDpmApiUrl(findEnvironment(environment)!, customUrl)).toEqual({
        error: expect.any(String),
      });
    },
  );

  it("takes HTTP://localhost through the same path", () => {
    const { customUrl } = environmentForUrl("HTTP://localhost:8086");
    expect(resolveDpmApiUrl(custom, customUrl)).toBe("HTTP://localhost:8086");
  });

  it("refuses plain http away from this computer, naming the reason", () => {
    expect(resolveDpmApiUrl(custom, "http://api.example.com")).toEqual({
      error: expect.stringMatching(/https:\/\/.*this computer/),
    });
  });

  it("still takes https and a platform on this computer over http", () => {
    expect(resolveDpmApiUrl(custom, "https://api.example.com/")).toBe("https://api.example.com");
    expect(resolveDpmApiUrl(custom, "http://localhost:8086")).toBe("http://localhost:8086");
  });
});

describe("the key is never re-sent on a redirect", () => {
  it("asks for the install config with redirect: error", async () => {
    let init: RequestInit | undefined;
    const spy: FetchLike = async (_url, options) => {
      init = options;
      return new Response(JSON.stringify(CONFIG), { status: 200 });
    };
    await fetchInstallConfig("https://x", "bld_sk_a", spy);
    expect(init?.redirect).toBe("error");
  });
});

describe("services the platform reports", () => {
  const reporting =
    (services: Record<string, string>): FetchLike =>
    async () =>
      new Response(JSON.stringify({ ...CONFIG, services }), { status: 200 });

  it("accepts https services, and http ones on this computer", async () => {
    await expect(
      fetchInstallConfig("https://x", "bld_sk_a", reporting(CONFIG.services)),
    ).resolves.toBeDefined();
    const local = await fetchInstallConfig(
      "http://localhost:8086",
      "bld_sk_a",
      reporting({
        dpm_api: "http://localhost:8086",
        gamma_api: "http://localhost:8084",
        relayer_api: "http://localhost:8085",
      }),
    );
    expect(local.services.gamma_api).toBe("http://host.docker.internal:8084");
  });

  it.each(["gamma_api", "relayer_api", "dpm_api", "data_api"])(
    "refuses a plain-http %s on another host",
    async (name) => {
      const services = {
        ...CONFIG.services,
        data_api: "https://data-api.example",
        [name]: "http://evil.example",
      };
      await expect(
        fetchInstallConfig("https://x", "bld_sk_a", reporting(services)),
      ).rejects.toThrow(/unsafe address/);
    },
  );

  it("refuses a non-http scheme", async () => {
    await expect(
      fetchInstallConfig(
        "https://x",
        "bld_sk_a",
        reporting({ ...CONFIG.services, gamma_api: "file:///etc/passwd" }),
      ),
    ).rejects.toThrow(/unsafe address/);
  });
});
