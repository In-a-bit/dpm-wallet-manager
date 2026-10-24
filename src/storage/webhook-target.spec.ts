import { assertWebhookTarget, isForbiddenWebhookAddress } from "./webhook-target";

describe("isForbiddenWebhookAddress", () => {
  it.each([
    "169.254.169.254",
    "169.254.0.1",
    "0.0.0.0",
    "fe80::1",
    "febf::1",
    "fd00:ec2::254",
    "[fd00:ec2::254]",
    "::ffff:169.254.169.254",
    "metadata.google.internal",
  ])("refuses %s", (address) => {
    expect(isForbiddenWebhookAddress(address)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.9",
    "93.184.216.34",
    "fd00:abcd::1",
    "hooks.example.com",
    "::1",
  ])("allows %s", (address) => {
    expect(isForbiddenWebhookAddress(address)).toBe(false);
  });
});

describe("assertWebhookTarget", () => {
  it("refuses a literal metadata URL without resolving anything", async () => {
    const resolve = jest.fn();
    await expect(
      assertWebhookTarget("http://169.254.169.254/latest/meta-data", resolve),
    ).rejects.toThrow(/forbidden/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a forbidden address, among others", async () => {
    await expect(
      assertWebhookTarget("https://rebind.example.com/x", async () => [
        "93.184.216.34",
        "169.254.169.254",
      ]),
    ).rejects.toThrow(/resolves/);
  });

  it("accepts an ordinary public name", async () => {
    await expect(
      assertWebhookTarget("https://hooks.example.com/x", async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
  });
});
