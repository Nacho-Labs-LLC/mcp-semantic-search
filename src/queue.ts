export class OpQueue {
  private queue = Promise.resolve();
  private onError?: ((err: unknown) => void) | undefined;

  constructor(onError?: (err: unknown) => void) {
    this.onError = onError;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolve: ((val: T | PromiseLike<T>) => void) | undefined;
    let reject: ((err: unknown) => void) | undefined;

    this.queue = new Promise<void>((res, rej) => {
      resolve = res as any;
      reject = rej;
    });

    // Suppress unhandled rejection errors from the internal queue promise
    this.queue.catch(() => {});

    try {
      await prev.catch(() => {});
      const result = await fn();
      resolve!(result);
      return result;
    } catch (err) {
      reject!(err);
      this.onError?.(err);
      throw err;
    }

  }
}
