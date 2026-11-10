import { createFauxClient } from "../../src/framework-testing.ts";
import type { FauxClient, FauxTurn } from "../../src/framework-testing.ts";
import type { LlmRequest } from "../../src/framework.ts";

export type ScriptedClient = FauxClient;
export type Script = FauxTurn[] | ((request: LlmRequest, index: number) => FauxTurn);
export const scriptedClient = (script: Script): FauxClient => createFauxClient(script);
