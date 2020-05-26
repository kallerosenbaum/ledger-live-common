/* eslint-disable no-console */
// @flow
import { generateMnemonic } from "bip39";
import { from } from "rxjs";
import { getEnv } from "@ledgerhq/live-common/lib/env";
import { runWithAppSpec } from "@ledgerhq/live-common/lib/bot/engine";
import allSpecs from "@ledgerhq/live-common/lib/generated/specs";

export default {
  description:
    "Run a bot test engine with speculos that automatically create accounts and do transactions",
  args: [],
  job: () => {
    // TODO have a way to filter a spec by name / family

    async function test() {
      const SEED = getEnv("SEED");

      if (!SEED) {
        console.log(
          "You didn't define SEED yet. Please use a new one SPECIFICALLY to this test and with NOT TOO MUCH funds. USE THIS BOT TO YOUR OWN RISK!\n" +
            "here is a possible software seed you can use:\n" +
            "SEED='" +
            generateMnemonic(256) +
            "'"
        );
        throw new Error("Please define a SEED env variable to run this bot.");
      }

      const specs = [];

      for (const family in allSpecs) {
        const familySpecs = allSpecs[family];
        for (const key in familySpecs) {
          specs.push(familySpecs[key]);
        }
      }

      const results = specs.map((spec) =>
        runWithAppSpec(
          // $FlowFixMe i'm not sure what happens with parametric type here
          spec,
          (log) => console.log(log)
        )
      );
      const combinedResults = await Promise.all(results);

      const errorCases = combinedResults.flat().filter((r) => r.error);

      if (errorCases.length) {
        errorCases.forEach((c) => console.error(c.error));
        process.exit(1);
      }
    }

    return from(test());
  },
};
