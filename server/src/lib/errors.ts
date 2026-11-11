export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  /** Extra top-level keys of the error body (e.g. `originalDate`, `onHand`). Never overrides code/message/fields. */
  readonly extra?: Record<string, unknown>;

  constructor(
    statusCode: number, code: string, message: string, fields?: Record<string, string>,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (fields !== undefined) this.fields = fields;
    if (extra !== undefined) this.extra = extra;
  }
}
