# Public HTTP controls and runtime packaging

The paid review endpoint already required an Agent bearer key and counted requests by key. The audit endpoint required a key and had no independent throttle. Public demo review had a route limiter. Simulation and commitment verification parsed their request bodies without route limits, and all protected POSTs parsed input before applying their access checks. The configured origin strings were not validated at startup. Behind a TLS-terminating proxy, an HTTPS browser origin must be configured explicitly because the application receives HTTP on its socket.

The runtime image also omitted two `examples/rebalancer` modules statically imported by the API. The local project has a Cloud Run build recipe without a verified service URL. The GitHub repository exposes no homepage, Pages site or registered deployment. A Vercel lookup for the project name and exact repository did not find a deployment in the linked account.

Acceptance requires a startable runtime file layout, bearer-protected reviews and audits with independent limits, exact browser origin admission, route limits before parsing, and a public offline demo. Preserve the wallet signature and one-time permit checks for the simulator. Retest the public service when its operator identifies the deployment.
