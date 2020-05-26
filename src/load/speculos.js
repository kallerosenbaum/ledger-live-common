// @flow
// Ledger internal speculos testing framework.
// loading this file have side effects and is only for Node.

import invariant from "invariant";
import path from "path";
import semver from "semver";
import { spawn, exec } from "child_process";
import { promises as fsp } from "fs";
import { log } from "@ledgerhq/logs";
import type { DeviceModelId } from "@ledgerhq/devices";
import SpeculosTransport from "@ledgerhq/hw-transport-node-speculos";
import { registerTransportModule } from "../hw";
import { getEnv } from "../env";
import { getDependencies } from "../apps/polyfill";
import { findCryptoCurrencyByKeyword } from "../currencies";

let idCounter = 0;
const data = {};

export function releaseSpeculosDevice(id: string) {
  log("speculos", "release " + id);
  const obj = data[id];
  if (obj) obj.destroy();
}

export function closeAllSpeculosDevices() {
  Object.keys(data).forEach(releaseSpeculosDevice);
}

export async function createSpeculosDevice({
  model,
  firmware,
  appName,
  appVersion,
  seed,
  coinapps,
  dependency,
}: {
  model: DeviceModelId,
  firmware: string,
  appName: string,
  appVersion: string,
  dependency?: string,
  seed: string,
  // Folder where we have app binaries
  coinapps: string,
}): Promise<{
  transport: SpeculosTransport,
  id: string,
}> {
  const id = `speculosID-${++idCounter}`;

  const apduPort = 40000 + idCounter;
  const vncPort = 41000 + idCounter;
  const buttonPort = 42000 + idCounter;
  const automationPort = 43000 + idCounter;

  log("speculos", "spawning with apdu=" + apduPort + " button=" + buttonPort);

  const p = spawn("docker", [
    "run",
    "-v",
    `${coinapps}:/speculos/apps`,
    "-p",
    `${apduPort}:40000`,
    "-p",
    `${vncPort}:41000`,
    "-p",
    `${buttonPort}:42000`,
    "-p",
    `${automationPort}:43000`,
    "-e",
    `SPECULOS_APPNAME=${appName}:${appVersion}`,
    "--name",
    `${id}`,
    "ledgerhq/speculos",
    "--model",
    model.toLowerCase(),
    `./apps/${model.toLowerCase()}/${firmware}/${appName}/app_${appVersion}.elf`,
    ...(dependency
      ? [
          "-l",
          `${dependency}:${`./apps/${model.toLowerCase()}/${firmware}/${dependency}/app_${appVersion}.elf`}`,
        ]
      : []),
    "--sdk",
    "1.6",
    "--seed",
    `${seed}`,
    "--display",
    "headless",
    "--vnc-password",
    "live",
    "--apdu-port",
    "40000",
    "--vnc-port",
    "41000",
    "--button-port",
    "42000",
    "--automation-port",
    "43000",
  ]);

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  p.stdout.on("data", (data) => {
    log("speculos", data);
  });

  p.stderr.on("data", (data) => {
    if (data.includes("using SDK")) {
      resolveReady();
    }
    if (process.env.VERBOSE) console.error(`${id}: ${data}`);
  });

  const destroy = () =>
    new Promise((resolve, reject) => {
      if (!data[id]) return;
      delete data[id];
      exec(`docker rm -f ${id}`, (error, stdout, stderr) => {
        if (error) {
          log("speculos", `ERROR: could not destroy ${id}: ${error} ${stderr}`);
          reject(error);
        } else {
          log("speculos", `destroyed ${id}`);
          resolve();
        }
      });
    });

  p.on("close", () => {
    destroy();
    rejectReady(
      new Error(
        "speculos process failure. Try `ledger-live cleanSpeculos` or check logs"
      )
    );
  });

  await ready;

  const transport = await SpeculosTransport.open({
    apduPort,
    buttonPort,
    automationPort,
  });

  data[id] = {
    process: p,
    apduPort,
    buttonPort,
    automationPort,
    transport,
    destroy,
  };

  return { id, transport };
}

export type AppCandidate = {
  path: string,
  model: DeviceModelId,
  firmware: string,
  appName: string,
  appVersion: string,
};

const modelMap: { [_: string]: DeviceModelId } = {
  nanos: "nanoS",
  nanox: "nanoX",
  blue: "blue",
};
const modelMapPriority: { [_: string]: number } = {
  nanos: 3,
  nanox: 2,
  blue: 1,
};

function hackBadSemver(str) {
  let [x, y, z, ...rest] = str.split(".");
  if (rest.length) {
    z += "-" + rest.join("-");
  }
  return [x, y, z].filter(Boolean).join(".");
}

// list all possible apps. sorted by latest first
export async function listAppCandidates(cwd: string): Promise<AppCandidate[]> {
  let candidates = [];

  const models = (await fsp.readdir(cwd))
    .map((modelName) => [modelName, modelMapPriority[modelName.toLowerCase()]])
    .filter(([, priority]) => priority)
    .sort((a, b) => b[1] - a[1])
    .map((a) => a[0]);

  for (const modelName of models) {
    const model = modelMap[modelName.toLowerCase()];
    const p1 = path.join(cwd, modelName);
    const firmwares = await fsp.readdir(p1);
    firmwares.sort((a, b) =>
      semver.compare(hackBadSemver(a), hackBadSemver(b))
    );
    firmwares.reverse();
    for (const firmware of firmwares) {
      const p2 = path.join(p1, firmware);
      const appNames = await fsp.readdir(p2);
      for (const appName of appNames) {
        const p3 = path.join(p2, appName);
        const elfs = await fsp.readdir(p3);
        const c = [];
        for (const elf of elfs) {
          if (elf.startsWith("app_") && elf.endsWith(".elf")) {
            const p4 = path.join(p3, elf);
            const appVersion = elf.slice(4, elf.length - 4);
            if (semver.valid(appVersion)) {
              c.push({
                path: p4,
                model,
                firmware,
                appName,
                appVersion,
              });
            }
          }
        }
        c.sort((a, b) => semver.compare(a.appVersion, b.appVersion));
        c.reverse();
        candidates = candidates.concat(c);
      }
    }
  }
  return candidates;
}

export type AppSearch = {
  model?: DeviceModelId,
  firmware?: string,
  appName?: string,
  appVersion?: string,
};

export function appCandidatesMatches(
  appCandidate: AppCandidate,
  search: AppSearch
): boolean {
  return (
    (!search.model || search.model === appCandidate.model) &&
    (!search.appName || search.appName === appCandidate.appName) &&
    (!search.firmware ||
      appCandidate.firmware === search.firmware ||
      semver.satisfies(
        hackBadSemver(appCandidate.firmware),
        search.firmware
      )) &&
    (!search.appVersion ||
      semver.satisfies(appCandidate.appVersion, search.appVersion))
  );
}

export const findAppCandidate = (
  appCandidates: AppCandidate[],
  search: AppSearch
): ?AppCandidate => appCandidates.find((c) => appCandidatesMatches(c, search));

function eatDevice(
  parts: string[]
): { model?: DeviceModelId, firmware?: string } {
  if (parts.length > 0) {
    const [modelQ, firmware] = parts[0].split("@");
    const model: DeviceModelId = modelMap[(modelQ || "").toLowerCase()];
    if (model) {
      parts.shift();
      if (firmware) {
        return { model, firmware };
      }
      return { model };
    }
  }
  return {};
}

function parseAppSearch(
  query: string
): ?{
  search: AppSearch,
  appName: string,
  dependency: string | void,
} {
  const parts = query.slice(9).split(":");
  const { model, firmware } = eatDevice(parts);
  if (parts.length === 0) return;
  const [nameQ, versionQ] = parts[0].split("@");
  const currency = findCryptoCurrencyByKeyword(nameQ);
  const appName = currency ? currency.managerAppName : nameQ;
  const version = versionQ || undefined;
  let dependency;
  if (currency) {
    dependency = getDependencies(currency.managerAppName)[0];
  }
  return {
    search: { model, firmware, appName, version },
    appName,
    dependency,
  };
}

async function openImplicitSpeculos(query: string) {
  const coinapps = getEnv("COINAPPS");
  invariant(coinapps, "COINAPPS folder is missing!");
  const seed = getEnv("SEED");
  invariant(seed, "SEED is missing!");
  const appCandidates = await listAppCandidates(coinapps);
  const match = parseAppSearch(query);
  invariant(
    match,
    "speculos: invalid format of '%s'. Usage example: speculos:nanoS:bitcoin@1.3.x",
    query
  );
  const { search, dependency, appName } = match;
  const appCandidate = findAppCandidate(appCandidates, search);
  invariant(appCandidate, "could not find an app that matches '%s'", query);
  const device = await createSpeculosDevice({
    ...appCandidate,
    coinapps,
    appName,
    dependency,
    seed,
  });
  return device.transport;
}

registerTransportModule({
  id: "speculos",
  open: (id): ?Promise<any> => {
    if (id.startsWith("speculosID")) {
      const obj = data[id];
      if (!obj) {
        throw new Error("speculos transport was destroyed");
      }
      return Promise.resolve(obj.transport);
    }
    if (id.startsWith("speculos:")) {
      return openImplicitSpeculos(id);
    }
  },
  close: (transport, id) => {
    if (id.startsWith("speculos")) {
      return Promise.resolve();
    }
  },
  disconnect: (deviceId) => {
    const obj = data[deviceId];
    if (obj) obj.destroy();
  },
});
