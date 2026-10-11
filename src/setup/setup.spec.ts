import fs from "node:fs";
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
  environmentForUrl,
  findEnvironment,
  resolveDpmApiUrl,
  toContainerUrl,
} from "./environments";
import {
  fetchInstallConfig,
  probePlatform,
  SetupError,
  type FetchLike,
  type InstallConfig,
} from "./platform-config";
import { generateInstallSecrets } from "./secrets";
import { JOURNEY } from "./catalog";
import { journey, stepDetails } from "./journey";
import { Journal, mask, type JournalEvent } from "./journal";
import { SetupService } from "./setup-service";
import { SetupStateStore, type SetupState } from "./state";
import { knownSecrets, supportReport } from "./support";
import { SetupWorker } from "./worker";
import {
  isComplete,
  progress,
  provision,
  STEPS,
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

describe("environmentForUrl", () => {
  it("names a listed platform by its id and any other as custom", () => {
    expect(environmentForUrl("https://dpm-api.inabit.dev/")).toEqual({ environment: "dev" });
    expect(environmentForUrl(" http://localhost:8086/ ")).toEqual({
      environment: "custom",
      customUrl: "http://localhost:8086",
    });
  });
});

describe("probePlatform", () => {
  const answering =
    (status: number): FetchLike =>
    async () =>
      new Response("{}", { status });

  it("accepts a platform that refuses a request without a key", async () => {
    let sentKey: string | null = "unset";
    await probePlatform("https://x", async (_url, init) => {
      sentKey = new Headers(init?.headers).get("X-Builder-Api-Private-Key");
      return new Response("{}", { status: 401 });
    });
    expect(sentKey).toBeNull();
  });

  it("tells a wrong or outdated address apart from a wrong key", async () => {
    await expect(probePlatform("https://x", answering(404))).rejects.toThrow(/self-install/);
    await expect(probePlatform("https://x", answering(502))).rejects.toThrow(/unavailable/);
    await expect(
      probePlatform("https://x", async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toThrow(/Could not reach/);
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
    if (path === "/v1/platform/operations-wallet") this.operationsCreated = true;
    if (path === "/v1/api-keys") return { status: 201, body: { key: "dpmm_dev_op_x" } };
    if (path === "/v1/ui-users") return this.uiUsers(method, options);
    if (path === "/v1/platform") return { status: 200, body: this.platform(options?.apiKey) };
    return { status: 200, body: { status: "ok" } };
  };

  mode = "shared";
  operationsCreated = false;
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
      operationsWallet: this.operationsCreated ? { id: "o" } : null,
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

  it("creates the operations wallet in segregated mode too: it is what funds users' wallets", async () => {
    const stack = new FakeStack();
    stack.mode = "segregated";
    const deps = provisioningDeps(stack, tempDir(), []);
    seedStarted(deps.store, "segregated");

    await provision(deps);

    expect(stack.count("POST /v1/platform/operations-wallet")).toBe(1);
    expect(isComplete(deps.store.load())).toBe(true);
  });

  it("does not call an install ready without its operations wallet", async () => {
    const stack = new FakeStack();
    stack.mode = "segregated";
    const deps = provisioningDeps(stack, tempDir(), []);
    seedStarted(deps.store, "segregated");
    deps.store.update((state) => {
      state.completedSteps = STEPS.filter((step) => step.id !== "verify").map((step) => step.id);
    });

    await expect(provision(deps)).rejects.toThrow(/there is no operations wallet/);
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

describe("SetupService and the worker", () => {
  const fetchOk: FetchLike = async () => new Response(JSON.stringify(PLATFORM), { status: 200 });
  const input = {
    environment: "dev",
    builderKey: "bld_sk_abcdef123456",
    mode: "shared",
    confirmModeIsPermanent: true,
  };

  it("records the answers and leaves provisioning to the worker", async () => {
    const stack = new FakeStack();
    const deps = provisioningDeps(stack, tempDir(), []);
    await new SetupService(deps, fetchOk).start(input);

    expect(stack.calls).toEqual([]);
    expect(deps.store.load().installId).toMatch(/^[0-9a-f]{8}$/);
    await new SetupWorker(deps).tick();
    expect(isComplete(deps.store.load())).toBe(true);
  });

  it("stops at a failure until a retry is asked for, then carries on", async () => {
    const stack = new FakeStack();
    stack.failures.set("/v1/platform/master-wallet", 1);
    const deps = provisioningDeps(stack, tempDir(), []);
    const service = new SetupService(deps, fetchOk);
    await service.start(input);
    const worker = new SetupWorker(deps);

    await worker.tick();
    expect(deps.store.load().lastError).toMatch(/upstream said no/);
    await worker.tick();
    expect(stack.count("POST /v1/platform/master-wallet")).toBe(1);

    service.retry();
    expect(service.retryPending()).toBe(true);
    await worker.tick();
    expect(isComplete(deps.store.load())).toBe(true);
    expect(service.retryPending()).toBe(false);
  });
});

describe("journal", () => {
  it("masks keys by their shape and last four characters", () => {
    const text =
      "key bld_sk_supersecretvalue1234 admin dpmm_dev_ad_abcdefghjkmnpqrs and 0123456789abcdef";
    expect(mask(text, ["0123456789abcdef"])).toBe(
      "key bld_sk_…1234 admin dpmm_dev_ad_…pqrs and …cdef",
    );
  });

  it("is masked on disk, and read back incrementally", () => {
    const dir = tempDir();
    const journal = new Journal(dir, () => ["the-wallet-secret"]);
    journal.append({ type: "note", message: "uses the-wallet-secret" });
    const first = journal.readFrom(0);
    expect(first.entries).toHaveLength(1);
    expect(fs.readFileSync(journal.file, "utf8")).not.toContain("the-wallet-secret");

    journal.append({ type: "note", message: "second" });
    fs.appendFileSync(journal.file, '{"type":"note"'); // a line still being written
    const next = journal.readFrom(first.offset);
    expect(next.entries.map((entry) => entry.type === "note" && entry.message)).toEqual(["second"]);
  });
});

describe("step reporting", () => {
  it("journals each step's start, progress and end, and the failure that stops it", async () => {
    const stack = new FakeStack();
    stack.failures.set("/v1/platform/master-wallet", 1);
    const events: JournalEvent[] = [];
    const deps = {
      ...provisioningDeps(stack, tempDir(), []),
      report: (e: JournalEvent) => void events.push(e),
    };
    seedStarted(deps.store, "segregated");

    await expect(provision(deps)).rejects.toThrow();
    const kinds = events.map((e) => `${e.type}:${"step" in e ? e.step : ""}`);
    expect(kinds.slice(0, 3)).toEqual([
      "step.start:write-config",
      "step.progress:write-config",
      "step.done:write-config",
    ]);
    expect(kinds).toContain("step.fail:master-wallet");
    expect(kinds).not.toContain("step.start:issue-operator-key");
  });

  it("names every step in the catalogue, in order", () => {
    const ids = JOURNEY.map((item) => item.id);
    const positions = STEPS.map((step) => ids.indexOf(step.id));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("journey", () => {
  it("asks for the platform on a new install, with everything else still to come", () => {
    const { rows, position, total } = journey(emptyLike(), [], { asking: "platform" });
    expect(rows.map((row) => row.status).slice(0, 3)).toEqual(["done", "asking", "pending"]);
    expect(position).toBe(2);
    expect(total).toBe(JOURNEY.length);
  });

  it("shows the running step with what it is doing, and what is still to come", () => {
    const store = new SetupStateStore(tempDir());
    seedStarted(store, "segregated");
    store.update((state) => {
      state.completedSteps = ["write-config"];
      state.running = true;
    });
    const at = new Date().toISOString();
    const rows = journey(
      store.load(),
      [
        { type: "step.start", step: "wallet-ready", at, pid: 1 },
        {
          type: "step.progress",
          step: "wallet-ready",
          message: "Still starting (check 3)",
          at,
          pid: 1,
        },
      ],
      {},
    ).rows;
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId.key).toMatchObject({ status: "done", result: "Acme (#7)" });
    expect(byId["wallet-ready"]).toMatchObject({
      status: "running",
      live: "Still starting (check 3)",
    });
    expect(byId["operations-wallet"]?.status).toBe("pending");
  });

  it("marks the step that failed, with its error", () => {
    const store = new SetupStateStore(tempDir());
    seedStarted(store, "shared");
    store.update((state) => {
      state.completedSteps = ["write-config", "wallet-ready"];
      state.lastError = "Creating the key vault failed (502)";
    });
    const failed = journey(store.load(), [], {}).rows.find((row) => row.status === "failed");
    expect(failed).toMatchObject({
      id: "vault-init",
      error: "Creating the key vault failed (502)",
    });
  });

  it("gathers a step's journal lines, including its requests", () => {
    const at = new Date().toISOString();
    const details = stepDetails(
      [
        { type: "step.start", step: "vault-init", at, pid: 1 },
        {
          type: "http",
          method: "POST",
          url: "http://w/v1/vault/init",
          status: 502,
          ms: 40,
          at,
          pid: 1,
        },
        { type: "step.fail", step: "vault-init", ms: 41, error: "no", at, pid: 1 },
        { type: "step.start", step: "other", at, pid: 1 },
      ],
      "vault-init",
    );
    expect(details.map((entry) => entry.type)).toEqual(["step.start", "http", "step.fail"]);
  });
});

describe("support report", () => {
  it("describes the install without any of its secrets", async () => {
    const stack = new FakeStack();
    const dir = tempDir();
    const deps = provisioningDeps(stack, dir, []);
    seedStarted(deps.store, "shared");
    const journal = new Journal(dir, () => knownSecrets(deps.store.load()));
    await provision({ ...deps, report: (event) => journal.append(event) });
    const state = deps.store.load();
    journal.append({ type: "note", message: `leaked ${state.secrets?.walletEncryptionKey}` });

    const report = supportReport(state, journal, [{ label: "Wallet service", ok: true }]);
    expect(report).toContain("Acme (#7)");
    expect(report).toContain("[done   ] Check everything works");
    for (const secret of knownSecrets(state)) expect(report).not.toContain(secret);
  });
});

function emptyLike(): SetupState {
  return new SetupStateStore(tempDir()).load();
}

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
