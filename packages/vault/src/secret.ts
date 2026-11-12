const REDACTED = '[REDACTED]';

/**
 * Wraps a sensitive value (OAuth token) so it cannot leak by accident: logs (pino uses toJSON),
 * JSON.stringify, string interpolation, util.inspect and error messages all print [REDACTED].
 * Only an explicit reveal() returns the value, at the single place that sends it to the platform.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${REDACTED})`;
  }
}
