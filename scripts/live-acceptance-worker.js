import { createHash } from "node:crypto";
import { once } from "node:events";
import { createApp } from "../server/index.js";
import { chainlinkMarket, rpcProvider } from "../server/market.js";
import { liveUsdMicros } from "../server/liveAcceptanceBudget.js";

if (typeof process.send !== "function") throw new Error("Launch acceptance worker with private IPC.");
const [config] = await once(process, "message");
let limit = liveUsdMicros;
const { owner, wallet, guardAddress, issuerKey, apiKey, database, rpc, ethFeed, usdcFeed, bounds } = config;
const provider = rpcProvider(rpc);
const unavailable = rpcProvider("http://127.0.0.1:1");
const market = chainlinkMarket({ provider, ethFeed, usdcFeed });
const failedMarket = chainlinkMarket({ provider: unavailable, ethFeed, usdcFeed });
let rpcDown = false;
const app = createApp({ owner, wallet, guardAddress, issuerKey, database,
  keyHashes: [createHash("sha256").update(apiKey).digest("hex")],
  marketFor: (decoded) => (rpcDown ? failedMarket : market)(decoded), routerBudgetLimit: "",
  liveAcceptance: { bounds, usdLimit: () => limit } });
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
process.on("message", ({ usdLimit, unavailableRpc }) => {
  if (typeof unavailableRpc === "boolean") {
    rpcDown = unavailableRpc;
    process.send({ rpcDown });
    return;
  }
  if (!Number.isSafeInteger(usdLimit) || usdLimit < 0 || usdLimit > liveUsdMicros) return;
  limit = usdLimit;
  process.send({ usdLimit: limit });
});
process.on("disconnect", () => {
  server.close(() => {
    app.locals.closeReviewStore();
    provider.destroy();
    unavailable.destroy();
  });
});
process.send({ port: server.address().port, pid: process.pid });
