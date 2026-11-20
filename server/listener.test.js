import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));

it.each([undefined, "localhost"])("starts the HTTP entry point with HOST=%s", async (host) => {
  const directory = mkdtempSync(path.join(tmpdir(), "proofguard-listener-"));
  const env = { PORT: "0", PROOFGUARD_DATABASE_PATH: ":memory:" };
  if (host) env.HOST = host;

  const child = spawn(process.execPath, [entrypoint], {
    cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });

  try {
    let origin;
    for await (const line of createInterface({ input: child.stdout })) {
      origin = /^ProofGuard listening on (http:\/\/\S+) \(rules-only mode\)$/.exec(line)?.[1];
      if (origin) break;
    }
    expect(origin, stderr).toBeDefined();
    if (!host) expect(new URL(origin).hostname).toBe("127.0.0.1");
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: "proofguard" });
  } finally {
    child.kill();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }

  if (host) expect(stderr).toContain(`HOST=${host} is different from the default loopback address`);
  else expect(stderr).not.toContain("default loopback address");
}, 10_000);
