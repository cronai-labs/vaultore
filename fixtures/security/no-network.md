---
ore: true
name: No network without the permission
description: Checks that a cell without the network permission has no route out.
tags: [security, fixture]
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: deny
---

# No network without the permission

Without `network: allow`, a container cell gets no network at all, only the loopback interface (permissions-spec §3.1). The probe lists the interfaces and tries one request.

It is most telling on a computer that is online.

```ore:ts id=probe
const fs = require("node:fs");
let request;
try {
	await fetch("https://example.com", { signal: AbortSignal.timeout(5000) });
	request = "answered";
} catch {
	request = "failed";
}
const results = {
	interfaces: fs.readdirSync("/sys/class/net").sort().join(","),
	request,
};
const expected = { interfaces: "lo", request: "failed" };
const crossed = Object.keys(expected).filter((key) => results[key] !== expected[key]);
if (crossed.length > 0) throw new Error("Not held: " + crossed.map((key) => `${key} (${results[key]})`).join(", "));
`held: ${Object.keys(expected).join(", ")}`;
```
