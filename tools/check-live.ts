// Read-only live check against production vendor APIs (GET/list only). Adapters register their checks
// here from phase 2 on. Never run from CI or the autopilot box (no credentials there by design).
console.log("check:live — no adapters registered yet; nothing to check.");
