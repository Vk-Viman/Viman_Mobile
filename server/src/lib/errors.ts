export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(statusCode: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (fields !== undefined) this.fields = fields;
  }
}
