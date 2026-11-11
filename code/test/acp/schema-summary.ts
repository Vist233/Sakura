// Reads the ACP v1 JSON schema that ships inside the pinned SDK and reduces it to the facts the agent relies on.
// The recorded copy lives in fixtures/protocol-v1.json; `sdk-pin.test.ts` compares the two, so an SDK change that alters the
// wire format fails a test instead of passing unnoticed. Regenerate on purpose with `UPDATE_ACP_FIXTURES=1 npm test`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type Definition = { properties?: Record<string, unknown>; oneOf?: Array<Record<string, unknown>>; enum?: unknown[]; required?: string[] };

const SHAPES = [
  "InitializeRequest",
  "InitializeResponse",
  "AgentCapabilities",
  "ClientCapabilities",
  "PromptCapabilities",
  "SessionCapabilities",
  "NewSessionRequest",
  "NewSessionResponse",
  "PromptRequest",
  "PromptResponse",
  "CancelNotification",
  "LoadSessionRequest",
  "SetSessionConfigOptionRequest",
  "UsageUpdate",
  "ToolCall",
  "ToolCallUpdate",
  "SessionConfigOption",
  "Plan",
] as const;

const VARIANTS = ["StopReason", "ToolKind", "ToolCallStatus", "ContentBlock", "SessionUpdate", "ToolCallContent", "PlanEntryStatus", "SessionConfigOptionCategory"] as const;

export interface SchemaSummary {
  sdkVersion: string;
  schemaSha256: string;
  methods: string[];
  /** Property names (and which are required) of the shapes the agent builds or reads. */
  shapes: Record<string, { properties: string[]; required: string[] } | "missing">;
  /** The `const` or `enum` values of the unions the agent switches on. */
  variants: Record<string, string[] | "missing">;
}

function discriminators(definition: Definition): string[] {
  if (definition.enum) return definition.enum.map(String);
  const found: string[] = [];
  for (const option of definition.oneOf ?? []) {
    if (typeof option.const === "string") found.push(option.const);
    else if (Array.isArray(option.enum)) found.push(...option.enum.map(String));
    else {
      const properties = (option.properties ?? {}) as Record<string, { const?: string; enum?: string[] }>;
      for (const key of ["sessionUpdate", "type"]) {
        const value = properties[key];
        if (value?.const !== undefined) found.push(value.const);
        else if (value?.enum) found.push(...value.enum);
      }
    }
  }
  return found.sort();
}

export function summariseSchema(): SchemaSummary {
  const require = createRequire(import.meta.url);
  const schemaPath = require.resolve("@agentclientprotocol/sdk/schema/v1/schema.json");
  const text = readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(text) as { $defs: Record<string, Definition> };
  const sdkPath = schemaPath.replace(/\/schema\/v1\/schema\.json$/, "/package.json");
  const sdk = JSON.parse(readFileSync(sdkPath, "utf8")) as { version: string };
  const methods = [...new Set([...text.matchAll(/"x-method":\s*"([^"]+)"/g)].map((match) => match[1]!))].sort();
  const shapes: SchemaSummary["shapes"] = {};
  for (const name of SHAPES) {
    const definition = schema.$defs[name];
    shapes[name] = definition ? { properties: Object.keys(definition.properties ?? {}).sort(), required: [...(definition.required ?? [])].sort() } : "missing";
  }
  const variants: SchemaSummary["variants"] = {};
  for (const name of VARIANTS) {
    const definition = schema.$defs[name];
    variants[name] = definition ? discriminators(definition) : "missing";
  }
  return { sdkVersion: sdk.version, schemaSha256: createHash("sha256").update(text).digest("hex"), methods, shapes, variants };
}
