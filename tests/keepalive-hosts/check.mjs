// Regression check for the Keep-alive workflow (LB cold-start bug:
// the workflow pinged only suspended workspace hostnames and a
// failed ping printed a warning without failing the job, so every
// session began on a cold 12s+ instance while CI stayed green).
// Pins: the three live origins, none of the suspended-era
// hostnames, the 10 minute schedule, and the fail-loud exit.
import { readFileSync } from "node:fs";

const wf = readFileSync(
  new URL("../../.github/workflows/keep-alive.yml", import.meta.url),
  "utf8",
);

let fails = 0;
const need = (cond, msg) => {
  if (!cond) {
    console.error("keepalive-hosts: FAIL " + msg);
    fails++;
  }
};

const LIVE = [
  "https://lobsterbrowse-server.onrender.com/healthz",
  "https://lobsterbrowse-beta.onrender.com/healthz",
  "https://lobsterbrowse-fixture.onrender.com/healthz",
];
for (const u of LIVE) need(wf.includes(u), "missing live origin " + u);

const DEAD = [
  "lobsterbrowse-g0bs",
  "lobsterbrowse-beta-9bct",
  "lobsterbrowse-content-2djv",
  "lobsterbrowse-wisp-8ec1",
  "lobsterbrowse-fixture-okp6",
  "lobsterbrowse-saha",
  "lobsterbrowse-beta-hcld",
  "lobsterbrowse-content-udk3",
];
for (const d of DEAD) need(!wf.includes(d), "suspended origin " + d + " still pinged");

need(wf.includes("exit 1"), "a failed ping must fail the job (exit 1)");
need(wf.includes('cron: "*/10'), "the schedule must stay every 10 minutes");

if (fails > 0) process.exit(1);
console.log("keepalive-hosts: all checks passed");
