import { assertPasswordAcceptable, hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
    await expect(verifyPassword("correct horse battery stapler", stored)).resolves.toBe(false);
  });

  it("salts every hash, so equal passwords do not look equal", async () => {
    expect(await hashPassword("same password here")).not.toBe(
      await hashPassword("same password here"),
    );
  });

  it("treats a malformed stored hash as a mismatch, not an error", async () => {
    await expect(verifyPassword("anything at all", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything at all", "scrypt$x$y$z$a$b")).resolves.toBe(false);
  });

  it("needs at least 12 characters", () => {
    expect(() => assertPasswordAcceptable("eleven-char")).toThrow(/at least 12/);
    expect(() => assertPasswordAcceptable("twelve-chars")).not.toThrow();
    expect(() => assertPasswordAcceptable("x".repeat(257))).toThrow(/at most 256/);
  });
});
