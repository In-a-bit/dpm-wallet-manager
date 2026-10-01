import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { parseApiKey } from "../crypto/api-key-format";
import {
  MANAGER_ENV_FILE,
  READY_MARKER,
  renderEnvFile,
  WALLET_ENV_FILE,
  walletEnv,
  writeInstallConfig,
  type InstallInputs,
} from "./config-writer";
import {
  DEFAULT_ENVIRONMENT,
  findEnvironment,
  resolveDpmApiUrl,
  toContainerUrl,
} from "./environments";
import {
  fetchInstallConfig,
  SetupError,
  type FetchLike,
  type InstallConfig,
} from "./platform-config";
import { generateInstallSecrets } from "./secrets";
import { createSetupServer, PinGuard } from "./server";
import { SetupService } from "./setup-service";
import { SetupStateStore, type SetupState } from "./state";
import {
  isComplete,
  progress,
  provision,
  type HttpResult,
  type ProvisioningDeps,
  type SetupHttp,
} from "./steps";

const PLATFORM: InstallConfig = {
  owner: { type: "builder", id: 7, name: "Acme", builder_type: "custody" },
  chain_id: 80002,
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

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dpm-setup-"));
}

describe("environments", () => {
  it("rewrites loopback service URLs to the Docker host, and leaves others alone", () => {
    expect(toContainerUrl("http://localhost:8084/")).toBe("http://host.docker.internal:8084");
    expect(toContainerUrl("http://127.0.0.1:8085")).toBe("http://host.docker.internal:8085");
    expect(toContainerUrl("https://gamma-api.dpm.network")).toBe("https://gamma-api.dpm.network");
  });

  it("starts on production, shown without the advanced toggle", () => {
    expect(findEnvironment(DEFAULT_ENVIRONMENT)).toMatchObject({ id: "prod", advanced: false });
  });

  it("reaches a platform on this computer through Custom", () => {
    const url = resolveDpmApiUrl(findEnvironment("custom")!, "http://localhost:8086");
    expect(toContainerUrl(url as string)).toBe("http://host.docker.internal:8086");
  });

  it("requires an http(s) address for a custom platform", () => {
    const custom = findEnvironment("custom")!;
    expect(resolveDpmApiUrl(custom, "ftp://x")).toEqual({ error: expect.any(String) });
    expect(resolveDpmApiUrl(custom, " https://api.example.com/ ")).toBe("https://api.example.com");
    expect(resolveDpmApiUrl(findEnvironment("prod")!)).toBe("https://api.dpm.network");
  });
});

describe("generateInstallSecrets", () => {
  it("produces values each service accepts at boot", () => {
    const secrets = generateInstallSecrets("dev");
    expect(secrets.walletEncryptionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.managerMasterKey).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.walletApiKey).toMatch(/^dpmw_[0-9a-f]{40}$/);
    expect(parseApiKey(secrets.adminKey)).toMatchObject({ role: "admin", environment: "dev" });
  });

  it("never repeats", () => {
    expect(generateInstallSecrets("dev").managerMasterKey).not.toBe(
      generateInstallSecrets("dev").managerMasterKey,
    );
  });
});

describe("config writer", () => {
  const inputs: InstallInputs = {
    answers: {
      environment: "dev",
      dpmApiUrl: "https://x",
      builderKey: " bld_sk_abc ",
      mode: "shared",
    },
    platform: PLATFORM,
    secrets: generateInstallSecrets("dev"),
    database: { user: "dpm", password: "p@ss/word" },
    keyEnv: "dev",
  };

  it("single-quotes every value and refuses one that could escape its quotes", () => {
    expect(renderEnvFile({ A: "b c" })).toContain("A='b c'");
    expect(() => renderEnvFile({ A: "it's" })).toThrow(/A contains/);
    expect(() => renderEnvFile({ A: "x\nB=y" })).toThrow(/A contains/);
  });

  it("maps the platform answer onto dpm-wallet's variables, trimming the pasted key", () => {
    const env = walletEnv(inputs);
    expect(env).toMatchObject({
      RELAYER_BUILDER_API_KEY: "bld_sk_abc",
      CHAIN_ID: "80002",
      GAMMA_API_URL: "https://gamma-api.example",
      CONTRACT_PROXY_IMPL: PLATFORM.contracts.proxy_impl,
    });
    // The builder key is the install's only platform credential.
    expect(env).not.toHaveProperty("APP_API_KEY");
    expect(env.DATABASE_URL).toBe("postgres://dpm:p%40ss%2Fword@postgres:5432/dpm_wallet");
  });

  it("writes both env files, then the ready marker", () => {
    const dir = tempDir();
    writeInstallConfig(dir, inputs);
    const manager = fs.readFileSync(path.join(dir, MANAGER_ENV_FILE), "utf8");
    expect(manager).toContain("DPM_WALLET_MANAGER_MODE='shared'");
    expect(manager).toContain(`DPM_WALLET_API_KEY='${inputs.secrets.walletApiKey}'`);
    expect(fs.existsSync(path.join(dir, WALLET_ENV_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, READY_MARKER))).toBe(true);
  });
});

describe("fetchInstallConfig", () => {
  const answering =
    (status: number, body: unknown = {}): FetchLike =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it("turns each platform refusal into something a person can act on", async () => {
    await expect(fetchInstallConfig("https://x", "bld_sk_a", answering(401))).rejects.toThrow(
      /not accepted/,
    );
    await expect(fetchInstallConfig("https://x", "bld_sk_a", answering(409))).rejects.toThrow(
      /embedded builder/,
    );
    await expect(fetchInstallConfig("https://x", "bld_sk_a", answering(503))).rejects.toThrow(
      /not ready for self-install/,
    );
    await expect(fetchInstallConfig("https://x", "  ", answering(200))).rejects.toThrow(/Paste/);
    await expect(
      fetchInstallConfig(
        "https://x",
        "bld_sk_a",
        async () => new Response("<html>…</html>", { status: 502 }),
      ),
    ).rejects.toThrow(
      /^The platform is temporarily unavailable \(502\)\. Try again in a few minutes\.$/,
    );
    await expect(
      fetchInstallConfig("https://x", "bld_sk_a", answering(404, { error: "not found" })),
    ).rejects.toThrow("The platform refused the request (404): not found");
  });

  it("reports an unreachable platform as a connection problem", async () => {
    const offline: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchInstallConfig("https://x", "bld_sk_a", offline)).rejects.toThrow(
      /Could not reach/,
    );
  });

  it("hands back service URLs reachable from inside the containers", async () => {
    const local = {
      ...PLATFORM,
      services: { ...PLATFORM.services, gamma_api: "http://localhost:8084" },
    };
    const config = await fetchInstallConfig(
      "http://localhost:8086",
      "bld_sk_a",
      answering(200, local),
    );
    expect(config.services.gamma_api).toBe("http://host.docker.internal:8084");
  });
});

/**
 * A fake of both services: counts every call, and can be told to fail one path a number of times
 * so a test can interrupt provisioning part-way and resume it.
 */
class FakeStack {
  calls: string[] = [];
  failures = new Map<string, number>();

  http: SetupHttp = async (method, url, options): Promise<HttpResult> => {
    const path = new URL(url).pathname;
    this.calls.push(`${method} ${path}`);
    const remaining = this.failures.get(path) ?? 0;
    if (remaining > 0) {
      this.failures.set(path, remaining - 1);
      // dpm-wallet's error envelope, which the message has to be dug out of.
      return { status: 502, body: { error: { code: "X", message: "upstream said no" } } };
    }
    if (path === "/v1/api-keys") return { status: 201, body: { key: "dpmm_dev_op_x" } };
    if (path === "/v1/ui-users") return this.uiUsers(method, options);
    if (path === "/v1/platform") return { status: 200, body: this.platform(options?.apiKey) };
    return { status: 200, body: { status: "ok" } };
  };

  mode = "shared";
  owners: Array<{ username: string; role: string; status: string }> = [];
  lastUserBody: unknown;

  private uiUsers(method: string, options?: { apiKey?: string; body?: unknown }): HttpResult {
    if (method === "GET")
      return { status: 200, body: { items: this.owners, total: this.owners.length } };
    this.lastUserBody = options?.body;
    const { username } = options?.body as { username: string };
    if (this.owners.some((owner) => owner.username === username)) {
      return { status: 409, body: { error: { code: "USERNAME_TAKEN", message: "taken" } } };
    }
    this.owners.push({ username, role: "owner", status: "active" });
    return { status: 201, body: { id: "u1", username } };
  }

  private platform(apiKey?: string): unknown {
    if (!apiKey) return {};
    return {
      mode: this.mode,
      masterWallet: { id: "m" },
      operationsWallet: this.mode === "shared" ? { id: "o" } : null,
      upstream: { reachable: true, vault: { initialized: true } },
    };
  }

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
}

function provisioningDeps(
  stack: FakeStack,
  dir: string,
  written: InstallInputs[],
): ProvisioningDeps {
  return {
    http: stack.http,
    store: new SetupStateStore(dir),
    writeConfig: (inputs) => written.push(inputs),
    sleep: async () => undefined,
    walletUrl: "http://wallet",
    managerUrl: "http://manager",
    database: { user: "dpm", password: "pw" },
    readyTimeoutMs: 1_000,
  };
}

function seedStarted(store: SetupStateStore, mode: "shared" | "segregated"): void {
  store.update((state: SetupState) => {
    state.answers = {
      environment: "dev",
      dpmApiUrl: "https://x",
      builderKey: "bld_sk_a",
      mode,
    };
    state.platform = PLATFORM;
    state.secrets = generateInstallSecrets("dev");
  });
}

describe("provision", () => {
  it("runs every step once, in order, and records the backend key", async () => {
    const stack = new FakeStack();
    const written: InstallInputs[] = [];
    const deps = provisioningDeps(stack, tempDir(), written);
    seedStarted(deps.store, "shared");

    const state = await provision(deps);

    expect(isComplete(state)).toBe(true);
    expect(state.operatorKey).toBe("dpmm_dev_op_x");
    expect(written).toHaveLength(1);
    expect(stack.calls.filter((c) => c.startsWith("POST"))).toEqual([
      "POST /v1/vault/init",
      "POST /v1/platform/master-wallet",
      "POST /v1/platform/operations-wallet",
      "POST /v1/api-keys",
    ]);
  });

  it("skips the operations wallet in segregated mode", async () => {
    const stack = new FakeStack();
    stack.mode = "segregated";
    const deps = provisioningDeps(stack, tempDir(), []);
    seedStarted(deps.store, "segregated");

    await provision(deps);

    expect(stack.count("POST /v1/platform/operations-wallet")).toBe(0);
  });

  it("resumes after a failure without repeating the steps that finished", async () => {
    const stack = new FakeStack();
    stack.failures.set("/v1/platform/master-wallet", 1);
    const dir = tempDir();
    const deps = provisioningDeps(stack, dir, []);
    seedStarted(deps.store, "shared");

    await expect(provision(deps)).rejects.toThrow(/master wallet failed \(502\): upstream said no/);
    const failed = deps.store.load();
    expect(failed.running).toBe(false);
    expect(failed.lastError).toMatch(/upstream said no/);
    expect(progress(failed).find((step) => step.id === "master-wallet")?.status).toBe("failed");

    // A fresh process, as after a reboot: only the state file carries over.
    const resumed = await provision(provisioningDeps(stack, dir, []));

    expect(isComplete(resumed)).toBe(true);
    expect(resumed.lastError).toBeUndefined();
    expect(stack.count("POST /v1/vault/init")).toBe(1);
    expect(stack.count("POST /v1/platform/master-wallet")).toBe(2);
  });

  it("refuses to finish when the running install is not what was asked for", async () => {
    const stack = new FakeStack();
    stack.mode = "segregated";
    const deps = provisioningDeps(stack, tempDir(), []);
    seedStarted(deps.store, "shared");

    await expect(provision(deps)).rejects.toThrow(/"segregated" mode, not "shared"/);
  });
});

describe("SetupService.start", () => {
  const fetchOk: FetchLike = async () => new Response(JSON.stringify(PLATFORM), { status: 200 });

  it("demands an explicit acknowledgement that the mode is permanent", async () => {
    const service = new SetupService(provisioningDeps(new FakeStack(), tempDir(), []), fetchOk);
    await expect(
      service.start({
        environment: "dev",
        builderKey: "bld_sk_a",
        mode: "shared",
        confirmModeIsPermanent: false,
      }),
    ).rejects.toBeInstanceOf(SetupError);
    expect(service.view().phase).toBe("new");
  });

  it("accepts only the first start", async () => {
    const deps = provisioningDeps(new FakeStack(), tempDir(), []);
    const service = new SetupService(deps, fetchOk);
    const input = {
      environment: "dev",
      builderKey: "bld_sk_a",
      mode: "shared",
      confirmModeIsPermanent: true,
    };

    await service.start(input);
    await expect(service.start({ ...input, mode: "segregated" })).rejects.toThrow(
      /already been started/,
    );
    expect(deps.store.load().answers?.mode).toBe("shared");
  });
});

describe("PinGuard", () => {
  it("locks out after repeated wrong PINs, even for the right one", () => {
    const guard = new PinGuard("123456");
    expect(guard.allows("123456")).toBe(true);
    for (let i = 0; i < 10; i++) guard.allows("000000");
    expect(guard.allows("123456")).toBe(false);
    expect(guard.lockedMessage()).toMatch(/Too many/);
  });
});

describe("setup server", () => {
  it("answers a failing route with its message instead of crashing", async () => {
    const service = new SetupService(provisioningDeps(new FakeStack(), tempDir(), []));
    const server = createSetupServer({
      service,
      pin: "123456",
      managerPublicUrl: "http://localhost:3000",
      liveStatus: async () => ({}),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const kit = await fetch(`http://127.0.0.1:${port}/api/backup-kit`, {
        headers: { "X-Setup-Pin": "123456" },
      });
      expect(kit.status).toBe(400);
      expect(await kit.json()).toEqual({ message: expect.stringMatching(/nothing to back up/) });

      const state = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { "X-Setup-Pin": "123456" },
      });
      expect(state.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("SetupService owner login", () => {
  async function provisioned(stack = new FakeStack()) {
    const dir = tempDir();
    const deps = provisioningDeps(stack, dir, []);
    seedStarted(deps.store, "shared");
    await provision(deps);
    return {
      stack,
      dir,
      deps,
      service: new SetupService(deps, fetch, "http://localhost:3000/admin"),
    };
  }

  it("creates the owner with the admin key, and never writes the password down", async () => {
    const { stack, dir, deps, service } = await provisioned();
    await service.createOwner("  alice  ", "a long enough passphrase");

    expect(stack.lastUserBody).toEqual({
      username: "alice",
      password: "a long enough passphrase",
      role: "owner",
    });
    expect(service.view().ownerCreated).toBe(true);
    const onDisk = fs.readFileSync(path.join(dir, "setup-state.json"), "utf8");
    expect(onDisk).not.toContain("a long enough passphrase");
    expect(deps.store.load().ownerCreated).toBe(true);
  });

  it("refuses before setup has finished, and a second time", async () => {
    const early = new SetupService(provisioningDeps(new FakeStack(), tempDir(), []));
    await expect(early.createOwner("alice", "a long enough passphrase")).rejects.toThrow(
      /Finish setup/,
    );

    const { service } = await provisioned();
    await service.createOwner("alice", "a long enough passphrase");
    await expect(service.createOwner("bob", "a long enough passphrase")).rejects.toThrow(
      /already exists/,
    );
  });

  it("explains a short password and a taken username", async () => {
    const { stack, service } = await provisioned();
    await expect(service.createOwner("alice", "short")).rejects.toThrow(/at least 12/);
    stack.owners.push({ username: "alice", role: "viewer", status: "active" });
    await expect(service.createOwner("alice", "a long enough passphrase")).rejects.toThrow(
      /already taken/,
    );
  });

  it("notices an owner that already exists, so it does not ask again", async () => {
    const stack = new FakeStack();
    stack.owners.push({ username: "pre-existing", role: "owner", status: "active" });
    const { service } = await provisioned(stack);
    expect(service.view().ownerCreated).toBe(false);
    await service.refreshOwnerStatus();
    expect(service.view().ownerCreated).toBe(true);
  });

  it("names the admin UI in the backup kit", async () => {
    const { service } = await provisioned();
    expect(service.backupKit()).toContain("Admin UI:           http://localhost:3000/admin");
  });
});
