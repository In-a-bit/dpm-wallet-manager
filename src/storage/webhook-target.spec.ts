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

describe("assertWebhookTarget through a URL string", () => {
  // The URL parser rewrites some of these (`::ffff:169.254.169.254` -> `::ffff:a9fe:a9fe`), so the
  // check must hold on what `new URL(...).hostname` actually returns.
  it.each([
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[0:0:0:0:0:ffff:169.254.169.254]/",
    "http://[::169.254.169.254]/",
    "http://[::a9fe:a9fe]/",
    "http://[64:ff9b::169.254.169.254]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[::ffff:0:169.254.169.254]/",
    "http://[::ffff:0:a9fe:a9fe]/",
    "http://[2002:a9fe:a9fe::1]/",
    "http://[2002:a9fe:a9fe::]/",
    "http://[fec0::1]/",
    "http://[fe80::1]/",
    "http://metadata.google.internal./",
    "http://METADATA.GOOGLE.INTERNAL/",
    "http://[fd00:ec2::254]/",
    "http://[FD00:0EC2:0:0:0:0:0:254]/",
    "http://169.254.169.254/",
    "http://2852039166/",
  ])("rejects %s", async (url) => {
    const resolve = jest.fn();
    await expect(assertWebhookTarget(url, resolve)).rejects.toThrow(/forbidden/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::ffff:93.184.216.34]/",
    "http://[::1]/",
    "http://[2606:4700::1111]/",
    "http://[2002:5db8:d822::1]/",
    "http://hooks.example.com./",
  ])("allows %s", async (url) => {
    await expect(assertWebhookTarget(url, async () => ["93.184.216.34"])).resolves.toBeUndefined();
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
