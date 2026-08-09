import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveThinkiteHome } from "./home.ts";

describe("resolveThinkiteHome", () => {
  let originalEnv: string | undefined;
  let originalLegacyEnv: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    originalEnv = process.env.THINKITE_HOME;
    originalLegacyEnv = process.env.SIDECODE_HOME;
    delete process.env.THINKITE_HOME;
    delete process.env.SIDECODE_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), "thinkite-home-test-"));
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.THINKITE_HOME;
    else process.env.THINKITE_HOME = originalEnv;
    if (originalLegacyEnv === undefined) delete process.env.SIDECODE_HOME;
    else process.env.SIDECODE_HOME = originalLegacyEnv;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("uses $THINKITE_HOME when set", () => {
    const target = join(tmpRoot, "custom");
    process.env.THINKITE_HOME = target;
    expect(resolveThinkiteHome()).toBe(target);
  });

  it("honors legacy $SIDECODE_HOME as fallback", () => {
    const target = join(tmpRoot, "legacy-env");
    process.env.SIDECODE_HOME = target;
    expect(resolveThinkiteHome()).toBe(target);
  });

  it("prefers $THINKITE_HOME over $SIDECODE_HOME", () => {
    const next = join(tmpRoot, "new-env");
    process.env.THINKITE_HOME = next;
    process.env.SIDECODE_HOME = join(tmpRoot, "old-env");
    expect(resolveThinkiteHome()).toBe(next);
  });

  it("creates directory with 0700 permissions", () => {
    const target = join(tmpRoot, "perm-test");
    process.env.THINKITE_HOME = target;
    resolveThinkiteHome();
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("is idempotent on an existing dir", () => {
    const target = join(tmpRoot, "idem");
    process.env.THINKITE_HOME = target;
    expect(resolveThinkiteHome()).toBe(target);
    expect(resolveThinkiteHome()).toBe(target);
  });

  it("uses homeDirOverride/.thinkite when env unset", () => {
    const result = resolveThinkiteHome(tmpRoot);
    expect(result).toBe(join(tmpRoot, ".thinkite"));
    expect(statSync(result).isDirectory()).toBe(true);
  });

  it("throws if path exists but is a file", () => {
    const target = join(tmpRoot, "iam-a-file");
    writeFileSync(target, "x");
    process.env.THINKITE_HOME = target;
    expect(() => resolveThinkiteHome()).toThrow(/not a directory/);
  });

  it("migrates a legacy .sidecode dir wholesale", () => {
    const legacy = join(tmpRoot, ".sidecode");
    mkdirSync(join(legacy, "sessions"), { recursive: true });
    writeFileSync(join(legacy, "identity.ed25519"), "fake-key");

    const result = resolveThinkiteHome(tmpRoot);

    expect(result).toBe(join(tmpRoot, ".thinkite"));
    expect(readFileSync(join(result, "identity.ed25519"), "utf8")).toBe(
      "fake-key",
    );
    expect(statSync(join(result, "sessions")).isDirectory()).toBe(true);
    expect(() => statSync(legacy)).toThrow(); // legacy dir is gone (renamed)
  });

  it("leaves legacy dir alone when .thinkite already exists", () => {
    const legacy = join(tmpRoot, ".sidecode");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "identity.ed25519"), "old");
    const next = join(tmpRoot, ".thinkite");
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, "identity.ed25519"), "new");

    const result = resolveThinkiteHome(tmpRoot);

    expect(result).toBe(next);
    expect(readFileSync(join(next, "identity.ed25519"), "utf8")).toBe("new");
    expect(readFileSync(join(legacy, "identity.ed25519"), "utf8")).toBe("old");
  });

  it("ignores a legacy path that is a file", () => {
    writeFileSync(join(tmpRoot, ".sidecode"), "not-a-dir");
    const result = resolveThinkiteHome(tmpRoot);
    expect(result).toBe(join(tmpRoot, ".thinkite"));
    expect(statSync(result).isDirectory()).toBe(true);
  });
});
