import { promisify } from "util"

export default class Iterator<T> {
  constructor(public next: () => T|Promise<T>) {
  }

  noRace(): Iterator<T> {
    let pending: Promise<T>;
    return new Iterator(() => {
      return pending = Promise.resolve(pending).then(() => this.next());
    });
  }

  keepWhile(cond: (value: T) => boolean): Iterator<T> {
    let value: T;
    return new Iterator(async () => {
      while (value === undefined || !await cond(value)) value = await this.next();
      return value;
    });
  }

  throttle(delay: number): Iterator<T> {
    let lastTime = 0;
    return new Iterator(async () => {
      const elapsed = Date.now() - lastTime;
      const remaining = delay - elapsed;
      if (remaining > 0) await promisify(setTimeout)(remaining);
      const value = await this.next();
      lastTime = Date.now();
      return value;
    });
  }
}
