/** A push-based async queue: the run pushes events, the caller iterates them. */
export interface Channel<T> {
  push(value: T): void;
  end(): void;
  iterable: AsyncIterable<T>;
}

export function createChannel<T>(): Channel<T> {
  const buffer: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };

  async function* iterate(): AsyncGenerator<T> {
    let position = 0;
    while (true) {
      if (position < buffer.length) {
        yield buffer[position++] as T;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    push(value) {
      buffer.push(value);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    iterable: { [Symbol.asyncIterator]: iterate },
  };
}
