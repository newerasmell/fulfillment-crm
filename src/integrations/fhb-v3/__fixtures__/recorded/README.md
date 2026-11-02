# Recorded FHB v3 fixtures

Written only by `pnpm fixtures:record -- --connection <id>` (GATE P2-G1, run by the owner against production,
GET calls only). Every JSON file here is scrubbed by `../../fixture-scrubber.ts`; the test
`fixture-scrubber.test.ts` fails if any value in a `body` could not have come from the scrubber, so never edit
these files by hand. Empty until the gate has run.
