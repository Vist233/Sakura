import type { LlmEvent } from "@sakura/kernel";

const encoder = new TextEncoder();

export function bytesStream(pieces: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const piece of pieces) yield typeof piece === "string" ? encoder.encode(piece) : piece;
  })();
}

export function sse(...chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("")}`;
}

export const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

/** Splits a string into byte pieces at the given offsets (offsets are in bytes). */
export function splitBytes(text: string, offsets: number[]): Uint8Array[] {
  const bytes = encoder.encode(text);
  const cuts = [0, ...offsets.filter((offset) => offset > 0 && offset < bytes.length).sort((a, b) => a - b), bytes.length];
  return cuts.slice(0, -1).map((start, index) => bytes.slice(start, cuts[index + 1]));
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export const textOfEvents = (events: LlmEvent[]) => events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("");

export function streamResponse(pieces: Array<string | Uint8Array>, init: ResponseInit = { status: 200 }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
      controller.close();
    },
  });
  return new Response(stream, init);
}
