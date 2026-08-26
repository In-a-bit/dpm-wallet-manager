/** The master key every test derives its pepper and encryption key from. Fixed, so a stored */
export const TEST_MASTER_KEY = "9f2c1ab4e0d75b3846a1c0ff1e2d3c4b5a69788796a5b4c3d2e1f00112233445";

/**
 * A complete, valid environment for tests. Every required variable is present, so a test that
 * cares about one value overrides just that one and stays readable.
 */
const BASE_ENV: Record<string, string> = {
  // Keeps test output readable; a test that cares about a log line overrides this.
  LOG_LEVEL: "error",
  // `DATABASE_URL` is not here: the harness mints a throwaway database per boot.
  DPM_WALLET_MANAGER_MODE: "segregated",
  DPM_WALLET_MANAGER_MASTER_KEY: TEST_MASTER_KEY,
  DPM_WALLET_MANAGER_KEY_ENV: "test",
  DPM_WALLET_BASE_URL: "https://dpm-wallet.test",
  DPM_WALLET_API_KEY: "upstream-test-key",
  WALLET_REF_PREFIX: "mgr:",
};

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}
