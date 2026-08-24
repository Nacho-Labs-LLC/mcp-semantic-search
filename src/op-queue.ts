export class OpQueue {
  private queue = Promise.resolve();

  constructor(private onError?: (err: unknown) => void) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolve: ((val: void | PromiseLike<void>) => void) | undefined;

    this.queue = new Promise<void>((res) => {
      resolve = res;
    });

    try {
      await prev.catch(() => {});
      const result = await fn();
      return result;
    } catch (err) {
      if (this.onError) {
        this.onError(err);
      }
      throw err;
    } finally {
      resolve!();
    }
  }
}
