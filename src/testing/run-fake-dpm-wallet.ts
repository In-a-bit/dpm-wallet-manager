import { FakeDpmWallet } from "./fake-dpm-wallet";

/**
 * Runs the stand-in dpm-wallet as a standalone process, so `scripts/smoke.sh` can be exercised
 * without a Turnkey-backed upstream.
 *
 * It proves the script, not the integration: the point of the smoke test is to run it against the
 * real service. This is how you check the script itself still works before you do.
 *
 *   npx ts-node src/testing/run-fake-dpm-wallet.ts 8090
 */
const port = Number(process.argv[2] ?? "8090");
const fake = new FakeDpmWallet();

// Registration is a precondition for every meta-transaction upstream, and the smoke script does
// not walk the DPM platform's own registration flow — so the stand-in treats every address as
// registered from the moment it is minted.
const seed = fake.seedAddress.bind(fake);
fake.seedAddress = (ref: string) => ({ ...markRegistered(seed(ref), fake, ref) });

function markRegistered(
  address: ReturnType<FakeDpmWallet["seedAddress"]>,
  wallet: FakeDpmWallet,
  ref: string,
) {
  const registered = { ...address, dpmRegistered: true };
  wallet.addresses.set(ref, registered);
  return registered;
}

// Wildcard bind, so a dpm-wallet-manager running in a container can reach it.
void fake.start(port, "0.0.0.0").then(() => {
  process.stdout.write(`fake dpm-wallet listening on ${fake.baseUrl}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void fake.stop().then(() => process.exit(0));
  });
}
